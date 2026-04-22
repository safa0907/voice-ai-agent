import { CosmosClient, Database, Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { config } from 'dotenv';
config();

let database: Database;
let container: Container;
let initialized = false;

/**
 * Initialize Cosmos DB client and ensure database/container exist.
 */
async function ensureInitialized() {
    if (initialized) return;

    const endpoint = process.env.COSMOS_ENDPOINT || "";
    const databaseId = process.env.COSMOS_DATABASE || "voice-agent";
    const containerId = process.env.COSMOS_CONTAINER || "call-logs";

    if (!endpoint) {
        console.warn("Cosmos DB not configured — call logging disabled.");
        return;
    }

    try {
        const credential = new DefaultAzureCredential();
        const client = new CosmosClient({ endpoint, aadCredentials: credential });
        database = client.database(databaseId);
        container = database.container(containerId);
        initialized = true;
        console.log("Cosmos DB initialized.");
    } catch (error) {
        console.error("Failed to initialize Cosmos DB:", error);
    }
}

/**
 * Log a call lifecycle event (answered, disconnected, etc.)
 */
export async function logCallEvent(
    callConnectionId: string,
    callerId: string,
    eventType: string,
    metadata?: Record<string, any>
) {
    try {
        await ensureInitialized();
        if (!initialized) return;

        await container.items.create({
            id: `${callConnectionId}-${eventType}-${Date.now()}`,
            callConnectionId,
            callerId,
            eventType,
            timestamp: new Date().toISOString(),
            ...metadata,
        });
    } catch (error) {
        console.error("Failed to log call event:", error);
    }
}

/**
 * Log a conversation turn (customer speech + AI response).
 */
export async function logConversationTurn(
    callConnectionId: string,
    callerId: string,
    customerSpeech: string,
    aiResponse: string
) {
    try {
        await ensureInitialized();
        if (!initialized) return;

        await container.items.create({
            id: `${callConnectionId}-turn-${Date.now()}`,
            callConnectionId,
            callerId,
            eventType: "ConversationTurn",
            customerSpeech,
            aiResponse,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Failed to log conversation turn:", error);
    }
}
