const { Client, GatewayIntentBits } = require('discord.js');
const { OpenAI } = require("openai");
require("dotenv").config(); // Load environment variables from .env file

// Initialize the OpenAI and Discord client with API keys from environment variables
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Set up the Discord client with necessary intents for receiving messages
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Helper function to pause execution for a set amount of milliseconds
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// List of Discord channel IDs where the bot should listen for messages
const channelKeys = ["1202718026353475594", "1202718036797161482", "1202718047807340574", "1202718056254668840", "1202718080191434823", "1202718088554876928", "1202718095571947610", "1202718104077992006", "1202718112902938684", "1202718133153169508", "1202718143185690666", "1202718152631255130", "1202718159816228874", "1202718167080894495", "1202718186693201970", "1202718194700128356", "1202718208025427988", "1202718218829963265", "1202718230259703819", "1202718241294913556", "1202718258332045452", "1202718267009929236", "1210671658772332615", "1210671699390107718", "1210671746143879178", "1210671777907474452", "1210671826972180500", "1217178700840308736", "1217180372098355360", "1224593438608068618", "1224748315296403536"];

// Mapping of Discord channel IDs to OpenAI thread IDs and a queue for messages
let threadMap = {};
let messageQueue = [];

// Log when the bot is successfully logged in and ready to receive messages
client.once('ready', () => {
    console.log('Bot is ready!');
    handleMessageQueue(); // Start processing the message queue
});

// Event listener for new messages, adding them to the queue if they're in the specified channels
client.on('messageCreate', message => {
    if (!message.author.bot && message.content && channelKeys.includes(message.channel.id)) {
        messageQueue.push(message); // Enqueue message
    }
});

// Function to handle errors specifically caused by active runs in OpenAI threads
const handleError = async (message, error) => {
    if (error.status === 400 && error.error && error.error.message.includes("Can't add messages to thread")) {
        console.log("Detected active run, retrying after delay...");
        await sleep(2000); // Delay to wait for the active run to possibly complete
        return handleMessage(message, true); // Retry handling the message with the retry flag set
    } else {
        console.error("Unhandled error:", error);
        throw error; // If the error is not related to active runs, rethrow it
    }
};

// Function to continuously handle messages from the queue
const handleMessageQueue = async () => {
    while (true) {
        if (messageQueue.length > 0) {
            const message = messageQueue.shift(); // Dequeue the first message
            try {
                await handleMessage(message, false); // Attempt to handle the message without the retry flag
            } catch (error) {
                console.error("Error handling message:", error);
            }
            await sleep(1000); // Wait a bit before processing the next message to manage rate limits
        } else {
            await sleep(100); // Short pause when queue is empty to prevent busy waiting
        }
    }
};

// Main function to handle a message from Discord and send a reply
const handleMessage = async (message, isRetry) => {
    if (!channelKeys.includes(message.channel.id)) return; // Ignore messages not in specified channels

    // Retrieve or create a thread mapping for the message's channel
    let threadId = threadMap[message.channel.id] || await createThreadAndMap(message.channel.id);

    console.log(`Sending to OpenAI: ${message.content}`);
    try {
        await addMessageToThread(threadId, message.content); // Add the message to the OpenAI thread
    } catch (error) {
        if (!isRetry) { // If this is the first attempt, handle the error and retry
            await handleError(message, error);
            return; // Stop further execution after retry
        } else {
            throw error; // If already a retry, rethrow the error to avoid infinite loops
        }
    }

    // Fetch a reply from OpenAI based on the thread and send it back in Discord
    const reply = await fetchAndSendReply(threadId, message);
    console.log(`Replying with: ${reply}`);
    message.reply(reply).catch(console.error); // Send the reply as a message in Discord
};

// Function to create a new OpenAI thread for a Discord channel and map them
const createThreadAndMap = async discordChannelId => {
    const threadResponse = await openai.beta.threads.create(); // Create a new thread
    threadMap[discordChannelId] = threadResponse.id; // Map the Discord channel to the new thread ID
    return threadResponse.id;
};

// Function to add a message to an OpenAI thread
const addMessageToThread = (threadId, content) => openai.beta.threads.messages.create(threadId, {
    role: "user",
    content
});

// Function to fetch a reply from OpenAI for a given thread and prepare it for sending in Discord
const fetchAndSendReply = async (threadId, message) => {
    const runResponse = await openai.beta.threads.runs.create(threadId, {
        assistant_id: process.env.ASSISTANT_ID, // Specify which assistant to use
    });
    await waitForRunCompletion(threadId, runResponse.id); // Wait for the run to complete

    // Fetch messages from the thread, filtering for the last reply from the assistant
    const messagesResponse = await openai.beta.threads.messages.list(threadId);
    const assistantMessages = messagesResponse.data.filter(msg => msg.role === "assistant" && msg.run_id === runResponse.id);

    // Prepare the reply message, handling cases where a response couldn't be generated
    let response = assistantMessages.length ? assistantMessages.pop().content[0].text.value : "Sorry, I didn't catch that. Could you do me a solid and send your message again? Thanks so much!";
    return response.length > 2000 ? "Hmm, my response is too long for Discord. Could you try breaking your message into smaller parts? I have a great memory so just ask me to take things one paragraph at a time!" : response;
};

// Function to poll an OpenAI thread's run status until it's completed
const waitForRunCompletion = async (threadId, runId) => {
    const terminalStates = ["cancelled", "failed", "completed", "expired"];
    let runResponse;
    do {
        runResponse = await openai.beta.threads.runs.retrieve(threadId, runId); // Check the run's status
        if (!terminalStates.includes(runResponse.status)) await sleep(1000); // Wait if the run is still active
    } while (!terminalStates.includes(runResponse.status)); // Loop until the run is in a terminal state
};

client.login(process.env.DISCORD_TOKEN); // Log in to Discord with the bot's token