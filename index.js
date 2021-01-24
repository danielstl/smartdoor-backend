const ipConfig = require("./config.json");

const express = require("express");
const app = express();
const server = app.listen(ipConfig.port);
const io = require("socket.io")(server, {
    cors: {
        origin: "*",
        //     credentials: true
    },
    //extraHeaders: {
    //    'Access-Control-Allow-Credentials': 'omit'
    //}
});
const fetch = require("node-fetch");

const ical = require("ical");
const cors = require("cors");
const multer = require("multer");
const history = require("connect-history-api-fallback"); //SPA redirection

const URL = "https://doorlink.xyz/";

app.use(cors());
app.use(history({
    rewrites: [
        {
            from: /\/manage/, to: function (context) {
                let path = context.parsedUrl.path;
                if (path.indexOf(".") > 0) { //path contains a dot
                    console.log("IGNORE!! " + path + path.indexOf("."));
                    return context.parsedUrl.href; //ignore!
                }

                return "/manage/index.html";
            }
        },
        {
            from: /\/display/, to: function (context) {
                let path = context.parsedUrl.path;
                if (path.indexOf(".") > 0) { //path contains a dot
                    console.log("IGNORE!! " + path + path.indexOf("."));
                    return context.parsedUrl.href; //ignore!
                }

                return "/display/index.html";
            }
        }
    ],
    verbose: true
}))

const mongoClient = require("mongodb").MongoClient;
const databaseUrl = "mongodb://localhost:27017/";

mongoClient.connect(databaseUrl).then(db => {
//app.use(cors());

//console.log(db);

    let dbo = db.db("smartdoor");
    let displays = dbo.collection("displays");

    app.get("/fetch-data/:id", async (req, res) => {
        let id = req.params.id;

        let doc = await displays.findOne({"_id": id});

        res.status(200).json(doc);

        //await displays.insertOne({"_id": "TEST", "test1": "test2"});
    });

    const storage = multer.diskStorage({
        destination: function (req, file, callback) {
            callback(null, __dirname + "/public/images")
        },
        filename: function (req, file, callback) {
            callback(null, new Date().getTime() + "-" + file.originalname);
        }
    });

    const upload = multer({dest: __dirname + "/public/images", storage});

    app.use("/", express.static(__dirname + "/public/")); //serve public html, including display and management app

    app.post("/upload/background-image/:roomId", upload.single("image"), async (req, res) => {
        if (!req.file) {
            res.status(400).json({error: "No image"});
            return;
        }

        let path = "images/" + req.file.filename;

        console.log("Saved image: " + path);

        io.emit("background_update", path);
        res.status(200).redirect("/manage/customise"); //todo temporary

        await displays.updateOne({"roomId": req.params.roomId}, {"$set": {"backgroundUrl": URL + path}});
    });

    app.post("/upload/user-icon/:roomId", upload.single("image"), async (req, res) => {
        if (!req.file) {
            res.status(400).json({error: "No image"});
            return;
        }

        let path = "images/" + req.file.filename;

        console.log("Saved image: " + path);

        res.status(200).redirect("/manage/profile"); //todo temporary

        let doc = await displays.findOneAndUpdate({"roomId": req.params.roomId}, {"$set": {"user.profileImage": URL + path}}, {returnOriginal: false});

        io.emit("user_update", doc.value.user);
    });

    let clientRooms = {}; //will be a map of clients -> room code

    async function getActiveDisplay(client) {
        return !clientRooms[client] ? null : await displays.findOne({"roomId": clientRooms[client]});
    }

    async function findAndUpdateActiveDisplay(client, updateQuery, options) {
        return !clientRooms[client] ? null : await displays.findOneAndUpdate({"roomId": clientRooms[client]}, updateQuery, options);
    }

    io.use((socket, next) => {
        next(); //TODO: middleware for authentication if needed goes here https://socket.io/docs/v3/middlewares/
    });

    function registerClientEvents(client, enableManagementEvents) {
        client.join(clientRooms[client]); //join them to the room for their room id

        client.on("get_room_id", async () => {
            client.emit("room_id", clientRooms[client]);
        });

        client.on("get_user", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            client.emit("user_update", doc.user);
        });

        client.on("get_background", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            client.emit("background_update", doc.backgroundUrl);
        });

        client.on("get_notes", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            client.emit("notes_update", doc.notes);
        });

        client.on("get_calendar", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            if (doc.calendarUrl) {
                let url = doc.calendarUrl;
                let data = await getCalendarData(url);
                io.emit("calendar_update", {url, data});
            } else {
                io.emit("calendar_update", null);
            }
        });

        client.on("send_message", async messageData => {
            io.emit("new_message", messageData);
        });

        //video chat

        client.on("start_intercom_call", sdp => {
            console.log("CALL!", sdp);
            client.broadcast.emit("intercom_call_signalling", {message: "sdp", sdp});
        });

        client.on("intercom_call_signalling", data => {
            console.log("intercom signalling!", data);
            client.broadcast.emit("intercom_call_signalling", data);
        });

        if (!enableManagementEvents) return; //don't register management events

        client.on("reset_room_id", async () => {
            let room = clientRooms[client];

            if (room !== null) {
                let newId = generateRoomId();
                await displays.updateOne({"roomId": room}, {"$set": {"roomId": newId}});

                clientRooms[client] = newId;

                client.emit("room_id", newId);

                client.join(newId);

                //Kick old clients out
                io.of('/').in(room).clients(function (error, clients) {
                    if (error || !clients) {
                        return;
                    }

                    clients.forEach(function (c) {
                        io.sockets.sockets[c].leave(room);
                    });
                });
            }
        });

        client.on("update_status", async status => {
            let doc = await findAndUpdateActiveDisplay(client, {"$set": {"user.status": status}}, {returnOriginal: false});

            io.emit("user_update", doc.value.user); //TODO emit only to room
        });

        client.on("update_name", async name => {
            let doc = await findAndUpdateActiveDisplay(client, {"$set": {"user.name": name}}, {returnOriginal: false});

            io.emit("user_update", doc.value.user);
        });

        client.on("update_notes", async notes => { //TODO validation
            let doc = await findAndUpdateActiveDisplay(client, {"$set": {"notes": notes}}, {returnOriginal: false});

            io.emit("notes_update", doc.value.notes);
        })

        client.on("update_calendar", async url => {
            await findAndUpdateActiveDisplay(client, {"$set": {"calendarUrl": url}});

            if (url) {
                let data = await getCalendarData(url);
                io.emit("calendar_update", {url, data});
            } else {
                io.emit("calendar_update", null);
            }
        });

        client.on("clear_messages", () => {
            io.emit("clear_messages");
        })
    }

//============== SOCKET.IO ==============
    io.on("connection", client => {
        console.log("Client connected");

        client.on("disconnect", () => {
            delete clientRooms[client];
        });

        client.on("join_room", async roomCode => {
            let doc = await displays.findOne({"roomId": roomCode});

            if (doc) {
                clientRooms[client] = roomCode;

                registerClientEvents(client, true); //allow clients to use the rest of the system

                client.emit("room_joined", roomCode);
            } else {
                client.emit("invalid_room_code");
            }
        });

        client.on("temp_join", async () => { //TODO
            let doc = await displays.findOne({"_id": "user1"});

            if (doc) {
                clientRooms[client] = doc.roomId;

                registerClientEvents(client, true); //allow clients to use the rest of the system

                client.emit("room_joined", doc.roomId);
            } else {
                client.emit("invalid_room_code");
            }
        });


    });
});

//getCalendarData("http://timetabling.lancaster.ac.uk/iCalendar/Personal.ics?ID=7CE1EE29-572E-44DF-86C5-E07770E93485");

function generateRoomId() {
    return Math.floor(1000000 + (Math.random() * 9000000)).toString();
}

async function getCalendarData(url) {
    let data = await fetch(url);
    data = await data.text();

    let cal = ical.parseICS(data);

    return Object.keys(cal).map(k => cal[k]).filter(e => e.type === "VEVENT").map(e => {
        return {
            name: e.summary,
            start: e.start.getTime(),
            end: e.end.getTime()
        }
    });

    //console.log(events);
    /*
        for (let ek in cal) {
            let event = cal[ek];
            if (event.type === 'VEVENT') {
                console.log(`${event.summary} is in ${event.location} on the ${event.start.getDate()} of ${event.start.getMonth()} at ${event.start.toLocaleTimeString('en-GB')}`);

            }
        }*/
}
