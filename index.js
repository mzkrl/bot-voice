require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { Client, GatewayIntentBits, REST, Routes } = require("discord.js");
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = "!";
const STATE_FILE = path.join(__dirname, "state.json");
const READY_TIMEOUT_MS = 20000;
const REJOIN_DELAY_MS = 5000;

if (!TOKEN) {
  console.error("DISCORD_TOKEN kosong di .env");
  process.exit(1);
}

const state = loadState();
const connections = new Map();
const rejoining = new Set();
const joinChains = new Map();

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [guildId, s] of Object.entries(parsed)) {
      if (s && typeof s.channelId === "string") {
        clean[guildId] = {
          channelId: s.channelId,
          joinedAt: Number.isFinite(s.joinedAt) ? s.joinedAt : Date.now(),
        };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function saveState() {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error("[state] gagal simpan state.json", e);
  }
}

function removeGuildState(guildId) {
  if (!(guildId in state)) return;
  delete state[guildId];
  saveState();
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h} jam ${m} menit ${s} detik`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const FULL_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];
const SAFE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
];

let client = null;

function destroyConnection(guildId) {
  const conn = connections.get(guildId);
  connections.delete(guildId);
  if (!conn) return;
  conn.removeAllListeners();
  try {
    conn.destroy();
  } catch {}
}

async function doJoinGuild(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.isVoiceBased()) {
    console.log(`[voice:${guild.id}] channel ${channelId} hilang, stop auto rejoin`);
    removeGuildState(guild.id);
    destroyConnection(guild.id);
    return false;
  }

  destroyConnection(guild.id);

  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
  } catch (e) {
    console.error(`[voice:${guild.id}] gagal join`, e);
    return false;
  }

  connection.on(VoiceConnectionStatus.Disconnected, (_, __, code) =>
    onDisconnected(guild.id, channel.id, code)
  );
  connection.on("error", (e) => console.error(`[voice:${guild.id}] connection error`, e));
  connections.set(guild.id, connection);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (e) {
    console.error(`[voice:${guild.id}] gagal ready`, e?.message ?? e);
    if (connections.get(guild.id) === connection) destroyConnection(guild.id);
    return false;
  }

  const prev = state[guild.id];
  state[guild.id] = {
    channelId: channel.id,
    joinedAt: prev?.joinedAt ?? Date.now(),
  };
  saveState();
  console.log(`[voice:${guild.id}] masuk ${channel.name}`);
  return true;
}

function joinGuild(guild, channelId) {
  const prev = joinChains.get(guild.id) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => doJoinGuild(guild, channelId));
  joinChains.set(guild.id, next.catch(() => {}));
  return next;
}

function onDisconnected(guildId, channelId, code) {
  const s = state[guildId];
  if (!s || s.channelId !== channelId) return;
  console.log(`[voice:${guildId}] terputus (code=${code ?? "?"}), auto rejoin...`);
  scheduleRejoin(guildId);
}

async function scheduleRejoin(guildId) {
  if (rejoining.has(guildId)) return;
  rejoining.add(guildId);
  try {
    while (state[guildId]) {
      await sleep(REJOIN_DELAY_MS);
      if (!state[guildId]) break;
      const conn = connections.get(guildId);
      if (conn && conn.state.status === VoiceConnectionStatus.Ready) break;
      const guild = client?.guilds?.cache?.get(guildId);
      if (!guild) break;
      console.log(`[voice:${guildId}] coba rejoin...`);
      if (await joinGuild(guild, state[guildId].channelId)) break;
    }
  } finally {
    rejoining.delete(guildId);
  }
}

async function doJoin(guild, channel, reply) {
  if (!guild) {
    await reply("Command ini cuma bisa dipake di dalam server.");
    return;
  }
  if (!channel || !channel.isVoiceBased()) {
    await reply("Masuk voice channel dulu, baru jalanin command ini.");
    return;
  }
  const prev = state[guild.id];
  state[guild.id] = { channelId: channel.id, joinedAt: prev?.joinedAt ?? Date.now() };
  saveState();
  const ok = await joinGuild(guild, channel.id);
  if (ok) {
    await reply(`Masuk **${channel.name}**. Bot bakal stay, keluarin pake \`${PREFIX}leave\` atau \`/leave\`.`);
  } else {
    await reply(`Gagal masuk **${channel.name}**, auto rejoin bakal nyoba terus.`);
    scheduleRejoin(guild.id);
  }
}

async function doLeave(guild, reply) {
  if (!guild) {
    await reply("Command ini cuma bisa dipake di dalam server.");
    return;
  }
  const s = state[guild.id];
  removeGuildState(guild.id);
  destroyConnection(guild.id);
  if (s) {
    await reply(`Dikeluarin dengan baik. Durasi numpuk: **${formatDuration(Date.now() - s.joinedAt)}**`);
  } else {
    await reply("Gak ada sesi voice yang perlu dikeluarin.");
  }
}

async function doStatus(guild, reply) {
  if (!guild) {
    await reply("Command ini cuma bisa dipake di dalam server.");
    return;
  }
  const s = state[guild.id];
  if (!s) {
    await reply("Belum ada sesi voice. Jalanin `!join` atau `/join` dulu.");
    return;
  }
  const conn = connections.get(guild.id);
  const inVc = conn && conn.state.status === VoiceConnectionStatus.Ready;
  await reply(
    `Status: **${inVc ? "stay di voice" : "reconnecting..."}**\n` +
      `Durasi: **${formatDuration(Date.now() - s.joinedAt)}**`
  );
}

const SLASH_COMMANDS = [
  { name: "join", description: "Masuk ke voice channel kamu dan stay" },
  { name: "leave", description: "Keluarin bot dari voice channel" },
  { name: "status", description: "Cek durasi bot numpuk di voice" },
];

function createClient(intents) {
  const c = new Client({ intents });
  client = c;

  c.on("error", (e) => console.error("client error", e));

  c.once("clientReady", async () => {
    console.log(`Logged in sebagai ${c.user.tag} (prefix: ${intents === SAFE_INTENTS ? "OFF, slash-only" : "ON"})`);
    c.user.setActivity(`/join buat numpuk jam`);

    try {
      await new REST()
        .setToken(TOKEN)
        .put(Routes.applicationCommands(c.application.id), { body: SLASH_COMMANDS });
      console.log("Slash commands terdaftar");
    } catch (e) {
      console.error("Gagal daftar slash commands", e);
    }

    for (const guildId of Object.keys(state)) {
      let guild = c.guilds.cache.get(guildId);
      if (!guild) {
        try {
          guild = await c.guilds.fetch(guildId);
        } catch {
          guild = null;
        }
      }
      if (!guild) {
        console.log(`[state] guild ${guildId} gak ketemu, buang dari state`);
        removeGuildState(guildId);
        continue;
      }
      const ok = await joinGuild(guild, state[guildId].channelId);
      if (!ok) scheduleRejoin(guildId);
    }
    saveState();
  });

  c.on("guildDelete", (guild) => {
    removeGuildState(guild.id);
    destroyConnection(guild.id);
  });

  c.on("messageCreate", async (msg) => {
    if (msg.author.bot || !msg.inGuild() || !msg.member) return;
    if (!msg.content.startsWith(PREFIX)) return;
    const [cmd] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const name = (cmd || "").toLowerCase();
    const reply = (t) => msg.reply(t);
    if (name === "join") await doJoin(msg.guild, msg.member.voice?.channel, reply);
    else if (name === "leave") await doLeave(msg.guild, reply);
    else if (name === "status") await doStatus(msg.guild, reply);
  });

  c.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const reply = (t) => interaction.reply(t);
    const channel = interaction.guild
      ? interaction.guild.channels.cache.get(interaction.member?.voice?.channelId)
      : null;
    if (interaction.commandName === "join") await doJoin(interaction.guild, channel, reply);
    else if (interaction.commandName === "leave") await doLeave(interaction.guild, reply);
    else if (interaction.commandName === "status") await doStatus(interaction.guild, reply);
  });

  c.on("voiceStateUpdate", (oldState, newState) => {
    const member = newState.member ?? oldState.member;
    if (!member || member.id !== c.user.id) return;
    const guildId = member.guild.id;
    const s = state[guildId];
    if (!s) return;
    const newChannelId = newState.channelId;
    if (newChannelId && newChannelId !== s.channelId) {
      console.log(`[voice:${guildId}] bot dipindah ke ${newChannelId}, balik ke target`);
      joinGuild(member.guild, s.channelId).then((ok) => {
        if (!ok) scheduleRejoin(guildId);
      });
    }
  });

  return c;
}

function start(intents) {
  const c = createClient(intents);
  c.login(TOKEN).catch((e) => {
    const msg = String(e?.message ?? e);
    const intentError = /disallowed intents|invalid intents|Used disallowed/i.test(msg);
    if (intentError && intents === FULL_INTENTS) {
      console.warn("Message Content Intent belum aktif di Developer Portal.");
      console.warn("Fallback ke slash-only (/join, /leave, /status). Nyalain intent di portal terus restart biar prefix ! hidup.");
      try {
        c.destroy();
      } catch {}
      start(SAFE_INTENTS);
      return;
    }
    console.error("Login gagal", e);
    process.exit(1);
  });
}

function shutdown(signal) {
  console.log(`[shutdown] ${signal}, simpan state & putus voice`);
  saveState();
  for (const guildId of [...connections.keys()]) destroyConnection(guildId);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => {
  console.error("uncaughtException", e);
  saveState();
  process.exit(1);
});

start(FULL_INTENTS);
