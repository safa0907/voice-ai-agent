import { AzureOpenAI } from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { config } from 'dotenv';
config();

const credential = new DefaultAzureCredential();
const azureADTokenProvider = getBearerTokenProvider(credential, "https://cognitiveservices.azure.com/.default");

const client = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
    azureADTokenProvider,
    apiVersion: "2024-10-21",
});

const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";

/**
 * Send conversation history to Azure OpenAI and get a response.
 * Keeps responses concise for voice playback.
 */
export async function getChatResponse(
    conversationHistory: Array<{ role: string; content: string }>
): Promise<string> {
    try {
        const response = await client.chat.completions.create({
            model: deploymentName,
            messages: conversationHistory as any,
            max_tokens: 80,
            temperature: 0.7,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            return "عذراً، لم أتمكن من فهم طلبك. هل يمكنك المحاولة مرة أخرى؟";
        }

        return content.trim();
    } catch (error) {
        console.error("Azure OpenAI error:", error);
        return "عذراً، هناك مشكلة تقنية. يرجى المحاولة مرة أخرى.";
    }
}
