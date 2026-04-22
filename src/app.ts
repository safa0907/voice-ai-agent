import { config } from 'dotenv';
import express, { Application, Request, Response } from 'express';
import {
    CallAutomationClient,
    CallConnection,
    CallMedia,
    AnswerCallOptions,
    AnswerCallResult,
    CallMediaRecognizeSpeechOptions,
    CallIntelligenceOptions,
    TextSource,
    PlayOptions,
} from "@azure/communication-call-automation";
import { createIdentifierFromRawId } from "@azure/communication-common";
import { v4 as uuidv4 } from 'uuid';
import { getChatResponse } from './openAiService';
import { logCallEvent, logConversationTurn } from './cosmosService';
import { publishConversationEvent, publishCallEvent } from './eventGridService';

config();

const PORT = process.env.PORT || 8080;
const app: Application = express();
app.use(express.json());

let acsClient: CallAutomationClient;

// Store active call state per connection
const activeCalls = new Map<string, {
    callConnection: CallConnection;
    callMedia: CallMedia;
    callerId: string;
    conversationHistory: Array<{ role: string; content: string }>;
    callStartTime: Date;
    timeoutCount: number;
    pendingAiResponse: Promise<string> | null;
    lastUserSpeech: string;
}>();

// --- Prompts (Arabic) ---
const SYSTEM_PROMPT = `أنت المساعد الصوتي الذكي لشركة نادك. نادك هي من أكبر شركات الأغذية والمشروبات في المملكة العربية السعودية.
تساعد العملاء في: معلومات المنتجات، استفسارات الطلبات والتوصيل، مواقع الفروع وأوقات العمل، المعلومات الغذائية، الشكاوى والملاحظات.

القواعد:
- رد دائماً باللغة العربية.
- اجعل ردودك مختصرة (جملة أو جملتين بالكثير) لأنها ستُقال بالصوت.
- كن مهذباً ومحترفاً ومفيداً.
- إذا لم تستطع المساعدة، اعرض على العميل تحويله لموظف خدمة عملاء.`;

const HELLO_PROMPT = "مرحباً بك في نادك! كيف يمكنني مساعدتك اليوم؟";
const TIMEOUT_PROMPT = "عذراً، لم أسمع شيئاً. هل يمكنك إعادة كلامك؟";
const GOODBYE_PROMPT = "شكراً لاتصالك بنادك، نتمنى لك يوماً سعيداً!";

// Filler phrases to mask AI thinking latency (no repeats until all used)
// These sound like natural conversation starters, not "searching" phrases
const FILLER_PHRASES = [
    "نعم",
    "بالتأكيد",
    "طبعاً",
    "أكيد",
    "ممم",
    "حسناً",
    "تمام",
    "إي نعم",
    "طيّب",
];
let lastFillerIndex = -1;

// Arabic TTS voice (Saudi)
const VOICE_NAME = "ar-SA-HamedNeural";

const MAX_SILENCE_TIMEOUTS = 2;

// --- Initialize ACS Client ---
async function createAcsClient() {
    const connectionString = process.env.ACS_CONNECTION_STRING || "";
    acsClient = new CallAutomationClient(connectionString);
    console.log("Initialized ACS Client.");
}

// --- Helper: Start speech recognition ---
async function startRecognizing(
    callMedia: CallMedia,
    callerId: string,
    message: string,
    context: string
) {
    const play: TextSource = {
        text: message,
        voiceName: VOICE_NAME,
        kind: "textSource",
    };

    const recognizeOptions: CallMediaRecognizeSpeechOptions = {
        endSilenceTimeoutInSeconds: 1,
        playPrompt: play,
        initialSilenceTimeoutInSeconds: 15,
        interruptPrompt: true,
        operationContext: context,
        kind: "callMediaRecognizeSpeechOptions",
        speechLanguage: "ar-SA",
    };

    const targetParticipant = createIdentifierFromRawId(callerId);
    await callMedia.startRecognizing(targetParticipant, recognizeOptions);
}

// --- Helper: Play message ---
async function handlePlay(
    callMedia: CallMedia,
    textToPlay: string,
    context: string
) {
    const play: TextSource = {
        text: textToPlay,
        voiceName: VOICE_NAME,
        kind: "textSource",
    };
    const playOptions: PlayOptions = { operationContext: context };
    await callMedia.playToAll([play], playOptions);
}

// ========================
// EVENT GRID WEBHOOK — IncomingCall
// ========================
app.post("/api/incomingCall", async (req: Request, res: Response) => {
    const event = req.body[0];
    const eventData = event.data;

    // Handle Event Grid subscription validation
    if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
        console.log("Received SubscriptionValidation event");
        res.status(200).json({
            validationResponse: eventData.validationCode,
        });
        return;
    }

    // Respond to Event Grid immediately to prevent retries
    res.status(200).send();

    if (event.eventType === "Microsoft.Communication.IncomingCall") {
        const callerId = eventData.from.rawId;
        const uuid = uuidv4();
        const callbackUri = `${process.env.CALLBACK_URI}/api/callbacks/${uuid}?callerId=${callerId}`;
        const incomingCallContext = eventData.incomingCallContext;

        console.log(`Incoming call from: ${callerId}`);
        console.log(`Callback URI: ${callbackUri}`);

        try {
            // Configure cognitive services for STT/TTS
            const callIntelligenceOptions: CallIntelligenceOptions = {
                cognitiveServicesEndpoint: process.env.COGNITIVE_SERVICE_ENDPOINT,
            };

            const answerCallOptions: AnswerCallOptions = {
                callIntelligenceOptions: callIntelligenceOptions,
            };

            const answerCallResult: AnswerCallResult = await acsClient.answerCall(
                incomingCallContext,
                callbackUri,
                answerCallOptions
            );

            const callConnection = answerCallResult.callConnection;
            const callConnectionId = answerCallResult.callConnectionProperties.callConnectionId!;
            const callMedia = callConnection.getCallMedia();

            // Store call state
            activeCalls.set(callConnectionId, {
                callConnection,
                callMedia,
                callerId,
                conversationHistory: [{ role: "system", content: SYSTEM_PROMPT }],
                callStartTime: new Date(),
                timeoutCount: 0,
                pendingAiResponse: null,
                lastUserSpeech: "",
            });

            console.log(`Call answered. ConnectionId: ${callConnectionId}`);

            // Log call start (fire-and-forget — never block call handling)
            logCallEvent(callConnectionId, callerId, "CallAnswered").catch(() => {});
            publishCallEvent(callConnectionId, callerId, "CallAnswered").catch(() => {});
        } catch (error) {
            console.error("Error answering call:", error);
        }
    }
});

// ========================
// CALL AUTOMATION CALLBACKS
// ========================
app.post("/api/callbacks/:contextId", async (req: Request, res: Response) => {
    const event = req.body[0];
    const eventData = event.data;
    const callConnectionId = eventData.callConnectionId;

    console.log(`Event: ${event.type} | ConnectionId: ${callConnectionId}`);

    try {
        const callState = activeCalls.get(callConnectionId);
        if (!callState && event.type !== "Microsoft.Communication.CallDisconnected") {
            console.warn(`No active call found for ConnectionId: ${callConnectionId}`);
            res.status(200).send();
            return;
        }

        switch (event.type) {
            case "Microsoft.Communication.CallConnected": {
                console.log("Call connected — greeting caller");
                // Greet in Arabic
                await startRecognizing(callState!.callMedia, callState!.callerId, HELLO_PROMPT, "Greeting");
                publishConversationEvent(callConnectionId, callState!.callerId, "(بداية المكالمة)", HELLO_PROMPT).catch(() => {});
                break;
            }

            case "Microsoft.Communication.RecognizeCompleted": {
                if (eventData.recognitionType === "speech") {
                    const speechText = eventData.speechResult?.speech || "";
                    if (speechText) {
                        console.log(`Customer said: "${speechText}"`);
                        callState!.timeoutCount = 0;
                        callState!.lastUserSpeech = speechText;

                        // Add to conversation history
                        callState!.conversationHistory.push({ role: "user", content: speechText });

                        // Start AI call in parallel (don't await yet)
                        callState!.pendingAiResponse = getChatResponse(callState!.conversationHistory);

                        // Play a random filler phrase immediately to mask latency
                        // Pick a filler that's different from the last one
                        let idx = Math.floor(Math.random() * FILLER_PHRASES.length);
                        if (idx === lastFillerIndex) {
                            idx = (idx + 1) % FILLER_PHRASES.length;
                        }
                        lastFillerIndex = idx;
                        const filler = FILLER_PHRASES[idx];
                        console.log(`Playing filler: "${filler}"`);
                        await handlePlay(callState!.callMedia, filler, "Filler");
                    }
                }
                break;
            }

            case "Microsoft.Communication.RecognizeFailed": {
                const subCode = eventData.resultInformation?.subCode;
                console.log(`Recognize failed. SubCode: ${subCode}`);

                // 8510 = initial silence timeout
                if (subCode === 8510 && callState!.timeoutCount < MAX_SILENCE_TIMEOUTS) {
                    callState!.timeoutCount++;
                    await startRecognizing(callState!.callMedia, callState!.callerId, TIMEOUT_PROMPT, "Timeout");
                } else {
                    // Max timeouts reached — say goodbye
                    await handlePlay(callState!.callMedia, GOODBYE_PROMPT, "Goodbye");
                }
                break;
            }

            case "Microsoft.Communication.PlayCompleted": {
                if (eventData.operationContext === "Goodbye") {
                    console.log("Goodbye played — hanging up");
                    await callState!.callConnection.hangUp(true);
                } else if (eventData.operationContext === "Filler" && callState!.pendingAiResponse) {
                    // Filler finished — AI response should be ready (or nearly ready)
                    const aiResponse = await callState!.pendingAiResponse;
                    callState!.pendingAiResponse = null;
                    console.log(`AI response: "${aiResponse}"`);

                    // Add to conversation history
                    callState!.conversationHistory.push({ role: "assistant", content: aiResponse });

                    // Log conversation turn (fire-and-forget)
                    logConversationTurn(callConnectionId, callState!.callerId, callState!.lastUserSpeech, aiResponse).catch(() => {});
                    publishConversationEvent(callConnectionId, callState!.callerId, callState!.lastUserSpeech, aiResponse).catch(() => {});

                    // Speak AI response and listen for next input
                    await startRecognizing(callState!.callMedia, callState!.callerId, aiResponse, "Conversation");
                }
                break;
            }

            case "Microsoft.Communication.PlayFailed": {
                console.error("Play failed — hanging up");
                if (callState) {
                    await callState.callConnection.hangUp(true);
                }
                break;
            }

            case "Microsoft.Communication.CallDisconnected": {
                const resultInfo = eventData.resultInformation;
                const state = activeCalls.get(callConnectionId);
                const duration = state ? Math.round((Date.now() - state.callStartTime.getTime()) / 1000) : 0;
                console.log(`Call disconnected: ${callConnectionId} (duration: ${duration}s) | Code: ${resultInfo?.code} SubCode: ${resultInfo?.subCode} Message: ${resultInfo?.message}`);
                if (state) {
                    logCallEvent(callConnectionId, state.callerId, "CallDisconnected", { durationSeconds: duration }).catch(() => {});
                    publishCallEvent(callConnectionId, state.callerId, "CallDisconnected", { durationSeconds: duration }).catch(() => {});
                    activeCalls.delete(callConnectionId);
                }
                break;
            }

            default:
                console.log(`Unhandled event: ${event.type}`);
        }

        res.status(200).send();
    } catch (error) {
        console.error(`Error handling callback ${event.type}:`, error);
        res.status(500).send();
    }
});

// ========================
// HEALTH CHECK
// ========================
app.get("/", (req: Request, res: Response) => {
    res.send("NADEC Voice AI Agent — Running");
});

app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// ========================
// START SERVER
// ========================
app.listen(PORT, async () => {
    console.log(`NADEC Voice AI Agent listening on port ${PORT}`);
    await createAcsClient();
    console.log("Ready to receive calls.");
});
