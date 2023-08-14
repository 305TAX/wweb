const qrcode = require("qrcode-terminal");

const { Client, RemoteAuth } = require("whatsapp-web.js");

// Require database
const { MongoStore } = require("wwebjs-mongo");
const mongoose = require("mongoose");

mongoose
  .connect(
    "mongodb+srv://root:0gxRn6a34pi82rr9@cluster0.ciy8q3a.mongodb.net/users_reviews"
  )
  .then(() => {
    const store = new MongoStore({ mongoose: mongoose });
    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 60000,
      }),
    });

    client.on("qr", (qr) => {
      qrcode.generate(qr, { small: true });
    });

    client.on("ready", async () => {
      console.log("readi!");
    });

    client.initialize();
  });
