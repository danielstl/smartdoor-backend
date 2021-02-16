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
}));

const mongoClient = require("mongodb").MongoClient;
const databaseUrl = "mongodb://localhost:27017/";

mongoClient.connect(databaseUrl).then(db => {

    let dbo = db.db("smartdoor");
    let displays = dbo.collection("displays");

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

        io.emit("background_update", URL + path);
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

    app.post("/upload/note-image/:roomId", upload.single("image"), async (req, res) => {
        if (!req.file) {
            res.status(400).json({error: "No image"});
            return;
        }

        let path = URL + "images/" + req.file.filename;

        res.status(200).json({url: path});
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

    function registerClientEvents(client, enableManagementEvents, newPairing) {
        client.join(clientRooms[client]); //join them to the room for their room id
        console.log("joined client to room " + clientRooms[client]);

        if (newPairing) {
            io.in(clientRooms[client]).emit("new_device_joined");
        }

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

        client.on("get_widgets", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            client.emit("widgets_update", doc.widgets);
        });

        client.on("get_notes", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            client.emit("notes_update", doc.notes);
        });

        client.on("get_doodles", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            client.emit("doodles_update", doc.doodles || []);
        });

        client.on("get_calendar", async () => {
            let doc = await getActiveDisplay(client);
            if (doc === null) {
                return;
            }

            let eventData = null;

            if (doc.calendars) {
                eventData = await getAllCalendarData(doc.calendars);
            }

            io.in(clientRooms[client]).emit("calendar_update", eventData);
        });

        client.on("send_message", async message => {
            if (!message || message === "") {
                return;
            }

            let messageObj = {
                content: message,
                fromSystem: enableManagementEvents,
                timestamp: new Date().getTime()
            }
            io.in(clientRooms[client]).emit("new_message", messageObj);
        });

        //video chat

        client.on("start_intercom_call", requestId => {
            if (requestId === undefined) {
                return;
            }

            io.in(clientRooms[client]).emit("intercom_call_request", requestId.toString());
            //console.log("CALL!", sdp);
            //client.broadcast.emit("intercom_call_signalling", {message: "sdp", sdp});
        });

        client.on("decline_call_request", requestId => {
            if (!requestId) {
                return;
            }

            io.in(clientRooms[client]).emit("decline_call_request", requestId.toString());
        });

        client.on("end_intercom_call", requestId => {
            if (!requestId) {
                return;
            }

            io.in(clientRooms[client]).emit("end_intercom_call", requestId.toString());
        });

        client.on("intercom_call_signalling", data => {
            console.log("intercom signalling!", data);
            client.broadcast.emit("intercom_call_signalling", data);
        });

        client.on("add_doodle", async doodleUrl => {
            let doc = await findAndUpdateActiveDisplay(client, {"$push": {"doodles": doodleUrl.toString()}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("doodles_update", doc.value.doodles);
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

        client.on("remove_doodle", async doodleUrl => {
            let doc = await findAndUpdateActiveDisplay(client, {"$pull": {"doodles": doodleUrl.toString()}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("doodles_update", doc.value.doodles);
        });

        client.on("update_status", async status => {
            let doc = await findAndUpdateActiveDisplay(client, {"$set": {"user.status": status.toString()}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("user_update", doc.value.user);
        });

        client.on("update_name", async name => {
            let doc = await findAndUpdateActiveDisplay(client, {"$set": {"user.name": name.toString()}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("user_update", doc.value.user);
        });

        client.on("remove_profile_picture", async () => {
            let doc = await findAndUpdateActiveDisplay(client, {"$set": {"user.profileImage": null}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("user_update", doc.value.user);
        });

        client.on("remove_background_image", async () => {
            await findAndUpdateActiveDisplay(client, {"$set": {"backgroundUrl": null}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("background_update", null);
        });

        client.on("update_widgets", async widgets => {
            //validate widgets to ensure data is sanitized
            let sanitizedWidgets = new Array(3);

            if (!(widgets instanceof Array)) {
                return;
            }

            for (let i = 0; i < 3; i++) {
                sanitizedWidgets[i] = widgets[i] ? widgets[i].toString() : null;
            }

            //TODO filter to valid widget types here

            await findAndUpdateActiveDisplay(client, {"$set": {"widgets": sanitizedWidgets}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("widgets_update", sanitizedWidgets);
        });

        client.on("update_notes", async notes => {
            //validate notes to ensure data is sanitized
            let sanitizedNotes = [];

            console.log(notes);

            if (!(notes instanceof Array)) {
                return;
            }

            notes.forEach(note => {
                console.log(note);
                if (!note.text && !note.image) {
                    return; //invalid note! needs either text or image
                }
                sanitizedNotes.push({
                    text: !note.text ? null : note.text.toString(),
                    image: !note.image ? null : note.image.toString()
                });
            });

            console.log("!!!!");
            console.log(sanitizedNotes);

            let doc = await findAndUpdateActiveDisplay(client, {"$set": {"notes": sanitizedNotes}}, {returnOriginal: false});

            io.in(clientRooms[client]).emit("notes_update", doc.value.notes);
        })

        client.on("update_calendar", async calendars => {
            let sanitizedCalendars = [];

            if (!(calendars instanceof Array)) {
                return;
            }

            calendars.forEach(cal => {
                console.log("CAL:", cal);
                if (!cal.url || !cal.colour) {
                    return;
                }
                sanitizedCalendars.push({url: cal.url.toString(), colour: cal.colour.toString()});
            });

            await findAndUpdateActiveDisplay(client, {"$set": {"calendars": sanitizedCalendars}});

            let eventData = await getAllCalendarData(calendars);

            io.in(clientRooms[client]).emit("calendar_update", eventData);

            /*if (url) {
                let data = await getCalendarData(url);
                io.in(clientRooms[client]).emit("calendar_update", {url, data});
            } else {
                io.in(clientRooms[client]).emit("calendar_update", null);
            }*/
        });

        client.on("clear_messages", () => {
            io.in(clientRooms[client]).emit("clear_messages");
        });

        client.on("delete_doodles", async () => {
            await findAndUpdateActiveDisplay(client, {"$set": {"doodles": []}})

            io.in(clientRooms[client]).emit("doodles_update", []);
        });
    }

//============== SOCKET.IO ==============
    io.on("connection", client => {
        console.log("Client connected");

        client.on("disconnect", () => {
            delete clientRooms[client];
        });

        client.on("join_room", async (roomCode, newPairing) => {
            let doc = await displays.findOne({"roomId": roomCode});

            if (doc) {
                clientRooms[client] = roomCode;

                registerClientEvents(client, true, newPairing); //allow clients to use the rest of the system

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

async function getAllCalendarData(calendars) {

    return await Promise.all(calendars.map(async c => new Object({
        url: c.url,
        events: await getCalendarData(c.url),
        colour: c.colour
    })));
}

async function getCalendarData(url) {
    let data = await fetch(url);
    data = await data.text();

    let cal = ical.parseICS(data);

    return Object.keys(cal).map(k => cal[k]).filter(e => e.type === "VEVENT").map(e => {
        return {
            name: e.summary,
            description: e.description,
            start: !e.start ? 0 : e.start.getTime(),
            end: !e.end ? 0 : e.end.getTime()
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
