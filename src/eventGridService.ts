import { EventGridPublisherClient, AzureKeyCredential } from "@azure/eventgrid";

const topicEndpoint = process.env.EVENT_GRID_TOPIC_ENDPOINT || "";
const topicKey = process.env.EVENT_GRID_TOPIC_KEY || "";

let client: EventGridPublisherClient<"EventGrid"> | null = null;

function getClient(): EventGridPublisherClient<"EventGrid"> | null {
    if (!topicEndpoint || !topicKey) {
        return null;
    }
    if (!client) {
        client = new EventGridPublisherClient(
            topicEndpoint,
            "EventGrid",
            new AzureKeyCredential(topicKey)
        );
    }
    return client;
}

export async function publishConversationEvent(
    callConnectionId: string,
    callerId: string,
    customerMessage: string,
    agentResponse: string
) {
    try {
        const egClient = getClient();
        if (!egClient) return;

        await egClient.send([
            {
                eventType: "NADEC.VoiceAgent.ConversationTurn",
                subject: `calls/${callConnectionId}`,
                dataVersion: "1.0",
                data: {
                    callConnectionId,
                    callerId,
                    timestamp: new Date().toISOString(),
                    customerMessage,
                    agentResponse,
                },
            },
        ]);
    } catch (error) {
        console.error("Failed to publish Event Grid event:", error);
    }
}

export async function publishCallEvent(
    callConnectionId: string,
    callerId: string,
    eventName: string,
    details?: Record<string, any>
) {
    try {
        const egClient = getClient();
        if (!egClient) return;

        await egClient.send([
            {
                eventType: `NADEC.VoiceAgent.${eventName}`,
                subject: `calls/${callConnectionId}`,
                dataVersion: "1.0",
                data: {
                    callConnectionId,
                    callerId,
                    timestamp: new Date().toISOString(),
                    eventName,
                    ...details,
                },
            },
        ]);
    } catch (error) {
        console.error("Failed to publish Event Grid event:", error);
    }
}
