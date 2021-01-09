const express = require("express");
const app = express();
const server = app.listen(3000);
const io = require("socket.io")(server, {
    cors: {
        origin: "http://localhost:8080",
        credentials: true
    }
});

const cors = require("cors");

app.use(cors({credentials: true, origin: "http://localhost:8080"}));

app.get("/", (req, res) => {
    res.send("hi");
});

io.on("connection", client => {
   console.log("Client connected");
});