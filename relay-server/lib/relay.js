import { WebSocketServer } from 'ws';
import { RealtimeClient } from '@openai/realtime-api-beta';
import { generateInstruction } from '../utils/instruction_config.js';
import axios from 'axios';

class Session {
  constructor(dataEndpoint, sessionJson) {
    this.dataEndpoint = dataEndpoint;
    if(sessionJson){
      this.set(sessionJson);
    }
  }

  set(sessionJson) {
    this.id = sessionJson["id"];
    this.userId = sessionJson["user_id"];
    this.openaiSessionId = sessionJson["openai_session_id"];
    this.questionGroups = sessionJson["question_groups"];
    this.questionsCsv = sessionJson["questions_csv"];
  }

  async createSession(sessionRequest) {
    const response = await axios.post(`${this.dataEndpoint}/v1/session/`, sessionRequest);
    this.set(response.data["result"]);
  }

  updateSession(sessionRequest) {
    axios.put(`${this.dataEndpoint}/v1/session/${this.id}/`, sessionRequest)
      .then(response => {
        console.log(response.data);
        this.set(response.data["result"])
      })
      .catch((error) => {
        console.error('[Error]', error);
      });
  }
}
export class RealtimeRelay {
  constructor(apiKey, dataEndpoint) {
    this.apiKey = apiKey;
    this.dataEndpoint = dataEndpoint;
    this.sockets = new WeakMap();
    this.wss = null;
  }

  listen(port) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', this.connectionHandler.bind(this));
    this.log(`Listening on ws://localhost:${port}`);
  }

  async connectionHandler(ws, req) {
    if (!req.url) {
      this.log('No URL provided, closing connection.');
      ws.close();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname !== '/') {
      this.log(`Invalid pathname: "${pathname}"`);
      ws.close();
      return;
    }

    // Instantiate new client
    this.log(`Connecting with key "${this.apiKey.slice(0, 3)}..."`);
    const client = new RealtimeClient({ apiKey: this.apiKey });

    let session = new Session(this.dataEndpoint);

    // Relay: OpenAI Realtime API Event -> Browser Event
    client.realtime.on('server.*', (event) => {
      if(event.type == 'session.created'){
        this.log(`session created: ${event.session.id}`);
        const sessionRequest = {
          "user_id": 1,
          "openai_session_id": event.session.id
        };
        // session.updateSession(sessionRequest);
        session.createSession(sessionRequest)
          .then(() => {
            console.log("session info: ", session);
            client.updateSession({
              instructions: generateInstruction(session.questionsCsv)
            });
            console.log("send update session ", client.sessionConfig);
          })
          .catch((error) => {
            console.error('[Error]', error);
          });
      }
      this.log(`Relaying "${event.type}" to Client`);
      ws.send(JSON.stringify(event));
    });
    client.realtime.on('close', () => ws.close());

    // Relay: Browser Event -> OpenAI Realtime API Event
    // We need to queue data waiting for the OpenAI connection
    const messageQueue = [];
    const messageHandler = (data) => {
      try {
        const event = JSON.parse(data);
        // A hack for instruction update. Then we could maintain instructions in relay server
        if(event.type == "session.update"){
          event.session.instructions = generateInstruction(session.questionsCsv);
        } 
        this.log(`Relaying "${event.type}" to OpenAI`);
        client.realtime.send(event.type, event);
      } catch (e) {
        console.error(e.message);
        this.log(`Error parsing event from client: ${data}`);
      }
    };
    ws.on('message', (data) => {
      if (!client.isConnected()) {
        messageQueue.push(data);
      } else {
        messageHandler(data);
      }
    });
    ws.on('close', () => client.disconnect());

    // Connect to OpenAI Realtime API
    try {
      this.log(`Connecting to OpenAI...`);
      await client.connect();
    } catch (e) {
      this.log(`Error connecting to OpenAI: ${e.message}`);
      ws.close();
      return;
    }
    this.log(`Connected to OpenAI successfully!`);
    while (messageQueue.length) {
      messageHandler(messageQueue.shift());
    }
  }

  log(...args) {
    console.log(`[RealtimeRelay]`, ...args);
  }
}
