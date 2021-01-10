const express = require("express");
const app = express();
const server = app.listen(3000);
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

app.use(cors());

const mongoClient = require("mongodb").MongoClient;
const databaseUrl = "mongodb://localhost:27017/";

mongoClient.connect(databaseUrl).then(db => {
    //app.use(cors());

    console.log(db);

    let dbo = db.db("smartdoor");
    let displays = dbo.collection("displays");

    app.get("/fetch-data/:id", async (req, res) => {
        let id = req.params.id;

        let doc = await displays.findOne({"_id": id});

        res.status(200).json(doc);

        //await displays.insertOne({"_id": "TEST", "test1": "test2"});
    });

    app.get("/", (req, res) => {
        res.send("hi");
    });

    io.on("connection", client => {
        console.log("Client connected");

        client.on("get_user", async () => {
            let doc = await displays.findOne({"_id": "user1"});

            //callback(doc.user);
            console.log("Emit!!");
            client.emit("user_update", doc.user);
        });

        client.on("update_status", async status => {
            let doc = await displays.findOneAndUpdate({"_id": "user1"}, {"$set": {"user.status": status}}, {returnOriginal: false});

            io.emit("user_update", doc.value.user);
        });

        client.on("update_name", async name => {
            let doc = await displays.findOneAndUpdate({"_id": "user1"}, {"$set": {"user.name": name}}, {returnOriginal: false});

            io.emit("user_update", doc.value.user);
        });

        client.on("get_calendar", async () => {
            let doc = await displays.findOne({"_id": "user1"});

            if (doc.calendarUrl) {
                let url = doc.calendarUrl;
                let data = await getCalendarData(url);
                io.emit("calendar_update", {url, data});
            } else {
                io.emit("calendar_update", null);
            }
        });

        client.on("update_calendar", async url => {
            await displays.updateOne({"_id": "user1"}, {"$set": {"calendarUrl": url}});

            if (url) {
                let data = await getCalendarData(url);
                io.emit("calendar_update", {url, data});
            } else {
                io.emit("calendar_update", null);
            }
        });
    });
});

//getCalendarData("http://timetabling.lancaster.ac.uk/iCalendar/Personal.ics?ID=7CE1EE29-572E-44DF-86C5-E07770E93485");

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
