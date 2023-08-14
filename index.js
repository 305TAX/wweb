"use strict";

require("dotenv").config();

/**
 * Require the dependencies
 * @type {*|createApplication}
 */
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const axios = require("axios");
const shelljs = require("shelljs");
var cron = require("node-cron");
const process = require("process");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");

const app = express();
const path = require("path");
const OAuthClient = require("intuit-oauth");
const config = require("./config.json");
const { Client, LocalAuth } = require("whatsapp-web.js");

const SCOPES = ["https://www.googleapis.com/auth/contacts"];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

process.title = "whatsapp-node-api";
global.client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

global.authed = false;

const ngrok = process.env.NGROK_ENABLED === "true" ? require("ngrok") : null;

/**
 * Configure View and Handlebars
 */
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "/public")));
app.engine("html", require("ejs").renderFile);

app.set("view engine", "html");
app.use(bodyParser.json());

const urlencodedParser = bodyParser.urlencoded({ extended: false });

/**
 * App Variables
 * @type {null}
 */
let oauth2_token_json = null;
let redirectUri = "";

/**
 * Instantiate new Client
 * @type {OAuthClient}
 */

let oauthClient = null;

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.promises.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
  const content = await fs.promises.readFile(CREDENTIALS_PATH);

  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.promises.writeFile(TOKEN_PATH, payload);
}

async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

async function listConnectionNames(auth) {
  const service = google.people({ version: "v1", auth });
  const res = await service.people.connections.list({
    resourceName: "people/me",
    personFields: "names,emailAddresses,phoneNumbers",
  });

  const connections = res.data.connections;

  if (!connections || connections.length === 0) {
    console.log("GOOGLE CONTACTS: No connections found.");
    return;
  }

  // console.log("Connections:");
  connections.forEach((person) => {
    if (person.names && person.names.length > 0) {
      console.log(person.names[0].displayName);
    } else {
      console.log("No display name found for connection.");
    }
  });
  return connections;
}

app.get("/list_google_contacts", async function (req, res) {
  const response = await authorize()
    .then(listConnectionNames)
    .catch(console.error);

  res.json({
    resultg: response,
  });
});

app.post("/create_google_contact", async function (req, res) {
  const newContact = req.query;

  async function createGoogleContact(auth, newContact) {
    const service = google.people({ version: "v1", auth });

    service.people
      .createContact({
        resource: {
          names: {
            givenName: String(newContact?.givenName),
          },
          emailAddresses: {
            value: String(newContact?.email),
            type: "home",
          },
          phoneNumbers: [
            {
              value: String(newContact?.mobile),
              type: "home",
            },
          ],
        },
      })
      .then((result) => {
        return res.json({
          state: true,
          result: result.data,
        });
      })
      .catch((error) => console.log("ERROR CREATE CONTACT", error));

  }

  const response = await authorize()
    .then((client) => createGoogleContact(client, newContact))
    .catch(console.error);

  // console.log("retunred contact", response);
  // res.json({
  //   result: "POSTEADO",
  // });
});

client.on("qr", (qr) => {
  console.log("qr");
  fs.writeFileSync("./components/last.qr", qr);
});

client.on("authenticated", () => {
  console.log("AUTH!");
  authed = true;

  try {
    fs.unlinkSync("./components/last.qr");
  } catch (err) {}
});

client.on("auth_failure", () => {
  console.log("AUTH Failed !");
  process.exit();
});

client.on("ready", () => {
  console.log("Client is ready!");
});

client.on("message", async (msg) => {
  if (config.webhook.enabled) {
    if (msg.hasMedia) {
      const attachmentData = await msg.downloadMedia();
      msg.attachmentData = attachmentData;
    }
    axios.post(config.webhook.path, { msg });
  }
});
client.on("disconnected", () => {
  console.log("disconnected");
});
client.initialize();

const chatRoute = require("./components/chatting");
const groupRoute = require("./components/group");
const authRoute = require("./components/auth");
const contactRoute = require("./components/contact");

app.use(function (req, res, next) {
  console.log(req.method + " : " + req.path);
  next();
});
app.use("/chat", chatRoute);
app.use("/group", groupRoute);
app.use("/auth", authRoute);
app.use("/contact", contactRoute);

/**
 * Home Route
 */
app.get("/", function (req, res) {
  res.render("index");
});

/**
 * Get the AuthorizeUri
 */
app.get("/authUri", urlencodedParser, function (req, res) {
  oauthClient = new OAuthClient({
    clientId: req.query.json.clientId,
    clientSecret: req.query.json.clientSecret,
    environment: req.query.json.environment,
    redirectUri: req.query.json.redirectUri,
  });

  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: "intuit-test",
  });
  res.send(authUri);
});

/**
 * Handle the callback to extract the `Auth Code` and exchange them for `Bearer-Tokens`
 */
app.get("/callback", function (req, res) {
  oauthClient
    .createToken(req.url)
    .then(function (authResponse) {
      oauth2_token_json = JSON.stringify(authResponse.getJson(), null, 2);
    })
    .catch(function (e) {
      console.error(e);
    });
  console.log("envio", req.url);
  res.send("CREADO");
});

/**
 * Display the token : CAUTION : JUST for sample purposes
 */
app.get("/retrieveToken", function (req, res) {
  res.send(oauth2_token_json);
});

/**
 * Refresh the access-token
 */
app.get("/refreshAccessToken", function (req, res) {
  oauthClient
    .refresh()
    .then(function (authResponse) {
      console.log(
        `The Refresh Token is  ${JSON.stringify(authResponse.getJson())}`
      );
      oauth2_token_json = JSON.stringify(authResponse.getJson(), null, 2);
      res.send(oauth2_token_json);
    })
    .catch(function (e) {
      console.error(e);
    });
});

cron.schedule("*/5 * * * *", () => {
  console.log("Running Task Refresh Token");
  oauthClient
    .refresh()
    .then(function (authResponse) {
      console.log(
        `The Refresh Token is  ${JSON.stringify(authResponse.getJson())}`
      );
      oauth2_token_json = JSON.stringify(authResponse.getJson(), null, 2);
    })
    .catch(function (e) {
      console.error(e);
    });
});

/**
 * getCompanyInfo ()
 */
app.get("/getCompanyInfo", function (req, res) {
  const companyID = oauthClient.getToken().realmId;

  const url =
    oauthClient.environment == "sandbox"
      ? OAuthClient.environment.sandbox
      : OAuthClient.environment.production;

  oauthClient
    .makeApiCall({
      url: `${url}v3/company/${companyID}/companyinfo/${companyID}`,
    })
    .then(function (authResponse) {
      console.log(
        `The response for API call is :${JSON.stringify(authResponse)}`
      );
      res.send(JSON.parse(authResponse.text()));
    })
    .catch(function (e) {
      console.error(e);
    });
});

app.get("/cc", function (req, res) {
  const companyID = oauthClient.getToken().realmId;
  res.header("Access-Control-Allow-Origin", "*");

  const url =
    oauthClient.environment == "sandbox"
      ? OAuthClient.environment.sandbox
      : OAuthClient.environment.production;

  const customerOdoo = JSON.parse(req.query.q);

  oauthClient
    .makeApiCall({
      url: `${url}v3/company/${companyID}/customer`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(customerOdoo),
    })
    .then(function (authResponse) {
      console.log(
        `The response for API call is :${JSON.stringify(authResponse)}`
      );
      res.send(JSON.parse(authResponse.text()));
    })
    .catch(function (e) {
      res.send(e);
      console.error(e);
    });
});

/**
 * disconnect ()
 */
app.get("/disconnect", function (req, res) {
  console.log("The disconnect called ");
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.OpenId, OAuthClient.scopes.Email],
    state: "intuit-test",
  });
  res.redirect(authUri);
});

/**
 * Start server on HTTP (will use ngrok for HTTPS forwarding)
 */
const server = app.listen(process.env.PORT || 8000, () => {
  console.log(`💻 Server listening on port ${server.address().port}`);

  authorize().then(listConnectionNames).catch(console.error);
  
  if (!ngrok) {
    redirectUri = `${server.address().port}` + "/callback";
    console.log(
      `💳  Step 1 : Paste this URL in your browser : ` +
        "http://localhost:" +
        `${server.address().port}`
    );
    console.log(
      "💳  Step 2 : Copy and Paste the clientId and clientSecret from : https://developer.intuit.com"
    );
    console.log(
      `💳  Step 3 : Copy Paste this callback URL into redirectURI :` +
        "http://localhost:" +
        `${server.address().port}` +
        "/callback"
    );
    console.log(
      `💻  Step 4 : Make Sure this redirect URI is also listed under the Redirect URIs on your app in : https://developer.intuit.com`
    );
  }
});

/**
 * Optional : If NGROK is enabled
 */
if (ngrok) {
  console.log("NGROK Enabled");

  // ngrok
  //   .connect({ addr: process.env.PORT || 3002 })
  //   .then((url) => {
  //     redirectUri = `${url}/callback`;
  //     console.log(`💳 Step 1 : Paste this URL in your browser :  ${url}`);
  //     console.log(
  //       "💳 Step 2 : Copy and Paste the clientId and clientSecret from : https://developer.intuit.com"
  //     );
  //     console.log(
  //       `💳 Step 3 : Copy Paste this callback URL into redirectURI :  ${redirectUri}`
  //     );
  //     console.log(
  //       `💻 Step 4 : Make Sure this redirect URI is also listed under the Redirect URIs on your app in : https://developer.intuit.com`
  //     );
  //   })
  //   .catch((error) => {
  //     console.log("ERROR", error,)
  //     process.exit(1);
  //   });
}
