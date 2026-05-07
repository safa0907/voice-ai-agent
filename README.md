# Voice AI Agent

An Arabic-speaking Voice AI Agent built with Azure Communication Services (ACS) Call Automation, Azure OpenAI, and Azure AI Speech.

When customers call the customer's phone number, the agent answers, greets them in Arabic, listens to their questions via speech-to-text, generates intelligent responses using GPT-4o, and speaks the answers back using text-to-speech — all in real time.

## Architecture

Open `architecture.drawio` in [draw.io](https://app.diagrams.net/) or VS Code with the Draw.io extension to view the full architecture diagram.

```
Customer Phone Call
        │
        ▼
Azure Communication Services (ACS)
        │
        ├── Event Grid (IncomingCall event)
        │         │
        │         ▼
        │   Dev Tunnel / App Server (Express.js on port 8080)
        │         │
        │         ├── Azure AI Speech (STT/TTS)
        │         │     └── ar-SA-HamedNeural voice
        │         │
        │         ├── Azure OpenAI (GPT-4o)
        │         │     └── Chat completions
        │         │
        │         ├── Azure Cosmos DB
        │         │     └── Call logs & conversation history
        │         │
        │         └── Event Grid Custom Topic
        │               └── Event Grid Viewer (real-time monitoring)
        │
        └── Call Automation SDK
              └── Answer, Recognize, Play, HangUp
```

## Azure Services Used

| Service | Resource Name | Region | Purpose |
|---------|--------------|--------|---------|
| Azure Communication Services | `acs-ndec1` | Global (UAE data) | Phone numbers, Call Automation |
| Azure OpenAI | `openai-nadec1` | East US 2 | GPT-4o chat completions |
| Azure AI Services (Cognitive) | `speech-nadec1-v2` | East US 2 | Speech-to-Text & Text-to-Speech |
| Azure Cosmos DB | `cosmos-nadec1` | East US 2 | Call logging & conversation storage |
| Azure Event Grid | `nadec-voice-events` | East US 2 | Real-time conversation event publishing |
| Event Grid Viewer | `nadeceventgridviewer` | Azure Web App | Real-time monitoring dashboard |

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- [Dev Tunnels CLI](https://learn.microsoft.com/azure/developer/dev-tunnels/get-started)
- An Azure subscription
- Azure CLI logged in (`az login`)

---

## Step-by-Step Setup Guide

### Step 1: Create a Resource Group

```bash
az group create --name rg-nadec1 --location eastus2
```

### Step 2: Create Azure Communication Services

```bash
az communication create \
  --name acs-ndec1 \
  --resource-group rg-nadec1 \
  --location global \
  --data-location uae
```

Enable System-assigned Managed Identity on the ACS resource (via Azure Portal → Identity → System assigned → On).

Purchase a phone number (toll-free) through the Azure Portal under your ACS resource → Phone Numbers → Get a number.

### Step 3: Create Azure AI Services (Cognitive Services)

This resource provides Speech-to-Text and Text-to-Speech with Arabic support. A **custom subdomain** is required for ACS Call Automation integration.

```bash
az cognitiveservices account create \
  --name speech-nadec1-v2 \
  --resource-group rg-nadec1 \
  --kind CognitiveServices \
  --sku S0 \
  --location eastus2 \
  --custom-domain speech-nadec1-v2
```

> **Important**: The `--custom-domain` flag is required. Without a custom subdomain, ACS Call Automation will fail with error code 8565 when trying to use Play/Recognize.

Grant ACS managed identity access to the Cognitive Services resource:

```bash
# Get the ACS managed identity principal ID
ACS_PRINCIPAL_ID=$(az communication show \
  --name acs-ndec1 --resource-group rg-nadec1 \
  --query identity.principalId -o tsv)

# Get the Cognitive Services resource ID
COGNITIVE_ID=$(az cognitiveservices account show \
  --name speech-nadec1-v2 --resource-group rg-nadec1 \
  --query id -o tsv)

# Assign Cognitive Services User role
az role assignment create \
  --assignee $ACS_PRINCIPAL_ID \
  --role "Cognitive Services User" \
  --scope $COGNITIVE_ID
```

### Step 4: Create Azure OpenAI

```bash
az cognitiveservices account create \
  --name openai-nadec1 \
  --resource-group rg-nadec1 \
  --kind OpenAI \
  --sku S0 \
  --location eastus2
```

Deploy the GPT-4o model:

```bash
az cognitiveservices account deployment create \
  --name openai-nadec1 \
  --resource-group rg-nadec1 \
  --deployment-name gpt-4o \
  --model-name gpt-4o \
  --model-version 2024-11-20 \
  --model-format OpenAI \
  --sku-capacity 10 \
  --sku-name Standard
```

Grant your user identity access (for local development with `DefaultAzureCredential`):

```bash
USER_ID=$(az ad signed-in-user show --query id -o tsv)

OPENAI_ID=$(az cognitiveservices account show \
  --name openai-nadec1 --resource-group rg-nadec1 \
  --query id -o tsv)

az role assignment create \
  --assignee $USER_ID \
  --role "Cognitive Services OpenAI User" \
  --scope $OPENAI_ID
```

### Step 5: Create Azure Cosmos DB (Optional — for call logging)

```bash
az cosmosdb create \
  --name cosmos-nadec1 \
  --resource-group rg-nadec1 \
  --locations regionName=eastus2 \
  --capabilities EnableServerless
```

Grant your user data contributor access:

```bash
COSMOS_ID=$(az cosmosdb show \
  --name cosmos-nadec1 --resource-group rg-nadec1 \
  --query id -o tsv)

az cosmosdb sql role assignment create \
  --account-name cosmos-nadec1 \
  --resource-group rg-nadec1 \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id $USER_ID \
  --scope $COSMOS_ID
```

> **Note**: If you have a Cosmos DB firewall enabled, add your public IP to the allowed list or enable "Allow access from Azure Portal" and "Accept connections from within public Azure datacenters".

### Step 6: Create Event Grid Custom Topic (Optional — for real-time monitoring)

```bash
az eventgrid topic create \
  --name nadec-voice-events \
  --resource-group rg-nadec1 \
  --location eastus2
```

Get the topic key for publishing events:

```bash
az eventgrid topic key list \
  --name nadec-voice-events --resource-group rg-nadec1 \
  --query key1 -o tsv
```

If you have an Event Grid Viewer web app deployed, create a subscription:

```bash
TOPIC_ID=$(az eventgrid topic show \
  --name nadec-voice-events --resource-group rg-nadec1 \
  --query id -o tsv)

az eventgrid event-subscription create \
  --name viewer-subscription \
  --source-resource-id $TOPIC_ID \
  --endpoint "https://<your-viewer-app>.azurewebsites.net/api/updates" \
  --endpoint-type webhook
```

### Step 7: Set Up Dev Tunnel

The dev tunnel exposes your local server to the internet so ACS Event Grid can deliver webhook events.

```bash
# Create a persistent tunnel
devtunnel create nadec-voice-agent --allow-anonymous

# Add port 8080
devtunnel port create nadec-voice-agent -p 8080

# Host the tunnel (keep running in a separate terminal)
devtunnel host nadec-voice-agent
```

Note the tunnel URL (e.g., `https://xxxxxxxx-8080.eun1.devtunnels.ms`).

### Step 8: Create Event Grid Subscription for Incoming Calls

Subscribe to `IncomingCall` events from ACS, pointing to your dev tunnel:

```bash
ACS_ID=$(az communication show \
  --name acs-ndec1 --resource-group rg-nadec1 \
  --query id -o tsv)

az eventgrid event-subscription create \
  --name voice-agent-incoming-call \
  --source-resource-id $ACS_ID \
  --endpoint "https://<your-tunnel-url>/api/incomingCall" \
  --endpoint-type webhook \
  --included-event-types Microsoft.Communication.IncomingCall
```

### Step 9: Install Dependencies and Configure

```bash
cd voice-ai-agent
npm install
```

Create a `.env` file:

```env
# Azure Communication Services
PORT=8080
ACS_CONNECTION_STRING="<your-acs-connection-string>"
CALLBACK_URI="https://<your-tunnel-url>"

# Azure AI Speech (for STT/TTS with Arabic support)
COGNITIVE_SERVICE_ENDPOINT="https://speech-nadec1-v2.cognitiveservices.azure.com/"

# Azure OpenAI (uses DefaultAzureCredential — no API key needed)
AZURE_OPENAI_ENDPOINT="https://openai-nadec1.openai.azure.com/"
AZURE_OPENAI_DEPLOYMENT="gpt-4o"

# Azure Cosmos DB (uses DefaultAzureCredential — no key needed)
COSMOS_ENDPOINT="https://cosmos-nadec1.documents.azure.com:443/"
COSMOS_DATABASE="voice-agent"
COSMOS_CONTAINER="call-logs"

# Azure Event Grid Custom Topic (for conversation monitoring)
EVENT_GRID_TOPIC_ENDPOINT="https://nadec-voice-events.eastus2-1.eventgrid.azure.net/api/events"
EVENT_GRID_TOPIC_KEY="<your-event-grid-topic-key>"
```

Get the ACS connection string:
```bash
az communication list-key \
  --name acs-ndec1 --resource-group rg-nadec1 \
  --query primaryConnectionString -o tsv
```

### Step 10: Build and Run

```bash
# Build TypeScript
npm run build

# Start the agent
npm start
```

### Step 11: Test

Call your ACS phone number. The agent will:

1. Answer the call automatically
2. Greet the caller in Arabic: "مرحباً بك في نادك! كيف يمكنني مساعدتك اليوم؟"
3. Listen to the caller's speech (Arabic speech recognition)
4. Send the speech to GPT-4o for an intelligent response
5. Speak the response back using Arabic TTS (`ar-SA-HamedNeural` voice)
6. Continue the conversation loop
7. Handle silence timeouts and say goodbye after 2 timeouts

---

## Project Structure

```
voice-ai-agent/
├── src/
│   ├── app.ts                # Main Express server, Event Grid webhook, Call Automation callbacks
│   ├── openAiService.ts      # Azure OpenAI GPT-4o integration (DefaultAzureCredential)
│   ├── cosmosService.ts      # Cosmos DB call logging (DefaultAzureCredential)
│   └── eventGridService.ts   # Event Grid event publishing for real-time monitoring
├── .env                      # Environment configuration
├── package.json
├── tsconfig.json
├── architecture.drawio       # Architecture diagram (open with draw.io)
└── README.md
```

## Key Features

- **Arabic Voice AI**: Full Arabic speech recognition and text-to-speech using `ar-SA-HamedNeural` voice
- **Barge-in Support**: Callers can interrupt the agent while it's speaking
- **Conversation Memory**: Multi-turn conversations with GPT-4o maintaining context per call
- **Real-time Monitoring**: Conversation events published to Event Grid Viewer
- **Call Logging**: All conversations stored in Cosmos DB
- **Silence Handling**: Automatic timeout prompts and graceful goodbye after 2 silent periods
- **Passwordless Auth**: Uses `DefaultAzureCredential` for OpenAI and Cosmos DB (no API keys)

## Authentication

The project uses **passwordless authentication** via `DefaultAzureCredential` from `@azure/identity` for:

| Service | Auth Method | Details |
|---------|------------|---------|
| Azure OpenAI | `DefaultAzureCredential` | `getBearerTokenProvider` with scope `https://cognitiveservices.azure.com/.default` |
| Azure Cosmos DB | `DefaultAzureCredential` | `aadCredentials` parameter on `CosmosClient` |
| ACS Call Automation | Connection String | ACS SDK requires connection string for Call Automation |
| ACS ↔ Cognitive Services | Managed Identity | ACS system-assigned identity with "Cognitive Services User" role |
| Event Grid Publishing | Access Key | Standard for Event Grid custom topic publishing |

## Call Flow

1. **Incoming Call** → Event Grid delivers `Microsoft.Communication.IncomingCall` to `/api/incomingCall`
2. **Answer Call** → ACS Call Automation SDK answers with Cognitive Services endpoint for STT/TTS
3. **Call Connected** → Agent greets caller in Arabic, starts speech recognition
4. **Recognize Completed** → Customer speech captured, sent to GPT-4o, response spoken back
5. **Recognize Failed (silence)** → Timeout prompt played, up to 2 retries before goodbye
6. **Play Completed (goodbye)** → Agent hangs up the call
7. **Call Disconnected** → Cleanup, log to Cosmos DB, publish Event Grid event

## Monitoring

Open the Event Grid Viewer at your deployed URL to see real-time events:

| Event Type | Trigger | Data |
|-----------|---------|------|
| `NADEC.VoiceAgent.CallAnswered` | Call picked up | `callConnectionId`, `callerId` |
| `NADEC.VoiceAgent.ConversationTurn` | Each exchange | `customerMessage`, `agentResponse` |
| `NADEC.VoiceAgent.CallDisconnected` | Call ended | `durationSeconds` |

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Play/Recognize fails with error 8565 | Cognitive Services resource has no custom subdomain | Create a new resource with `--custom-domain` flag |
| OpenAI returns 403 | Key auth disabled on the resource | Use `DefaultAzureCredential` with `azureADTokenProvider` instead of API key |
| Cosmos DB returns 403 Forbidden | Firewall blocking your IP | Add your IP to Cosmos DB networking settings or disable firewall |
| Event Grid subscription validation fails | Dev tunnel not running or URL mismatch | Ensure dev tunnel is active and URL matches the subscription endpoint |
| No incoming call events | Event Grid subscription not configured | Create subscription on ACS resource for `Microsoft.Communication.IncomingCall` |
```

### Update Event Grid webhook to Container App URL

Update the Event Grid subscription endpoint to:
```
https://voice-agent.<env-domain>.azurecontainerapps.io/api/incomingCall
```

## Project Structure

```
voice-ai-agent/
├── src/
│   ├── app.ts              # Express server, Event Grid webhook, Call Automation callbacks
│   ├── openAiService.ts    # Azure OpenAI chat completions
│   └── cosmosService.ts    # Cosmos DB call logging
├── Dockerfile              # Multi-stage Docker build
├── .dockerignore
├── .env                    # Environment variables (not committed)
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```
