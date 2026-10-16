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
const UNKNOWN_GUILD = 10004;

if (!TOKEN) {
  console.error("DISCORD_TOKEN kosong di .env");
  process.exit(1);
}

const state = loadState();
const connections = new Map();
const rejoining = new Set();
const joinChains = new Map();

let client = null;

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

function setTarget(guildId, channelId) {
  const prev = state[guildId];
  state[guildId] = {
    channelId,
    joinedAt: Number.isFinite(prev?.joinedAt) ? prev.joinedAt : Date.now(),
  };
  saveState();
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

function isUnknownError(e, code) {
  if (!e) return false;
  if (e.code === code) return true;
  return e.status === 404 && /unknown/i.test(String(e.message ?? ""));
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

function getConn(guildId) {
  const conn = connections.get(guildId);
  if (!conn) return null;
  if (conn.state.status === VoiceConnectionStatus.Destroyed) {
    connections.delete(guildId);
    return null;
  }
  return conn;
}

function destroyConnection(guildId) {
  const conn = connections.get(guildId);
  connections.delete(guildId);
  if (!conn) return;
  conn.removeAllListeners();
  try {
    conn.destroy();
  } catch {}
}

function connectionStatus(guildId) {
  return getConn(guildId)?.state?.status ?? null;
}

async function resolveVoiceChannel(guild, channelId) {
  let channel = guild.channels.cache.get(channelId) ?? null;
  if (!channel) {
    try {
      channel = await guild.channels.fetch(channelId);
    } catch (e) {
      console.log(`[voice:${guild.id}] channel ${channelId} belum kebaca`, e?.message ?? e);
      return null;
    }
  }
  return channel && channel.isVoiceBased() ? channel : null;
}

async function discordStillInChannel(guildId, channelId) {
  const guild = client?.guilds?.cache?.get(guildId);
  if (!guild) return null;
  let me = guild.members.me;
  if (!me) {
    try {
      me = await guild.members.fetchMe();
    } catch {
      return null;
    }
  }
  const current = me?.voice?.channelId ?? null;
  if (current === null) return false;
  return current === channelId ? true : "other";
}

function attachListeners(connection, guildId) {
  connection.on(VoiceConnectionStatus.Disconnected, (_, __, code) =>
    onDisconnected(guildId, code)
  );
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (connections.get(guildId) === connection) connections.delete(guildId);
  });
  connection.on("error", (e) => console.error(`[voice:${guildId}] connection error`, e));
}

async function freshJoin(guild, channel) {
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

  attachListeners(connection, guild.id);
  connections.set(guild.id, connection);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (e) {
    console.error(`[voice:${guild.id}] gagal ready`, e?.message ?? e);
    if (connections.get(guild.id) === connection) destroyConnection(guild.id);
    return false;
  }

  setTarget(guild.id, channel.id);
  console.log(`[voice:${guild.id}] join baru -> ${channel.name}`);
  return true;
}

async function ensureConnected(guild, channelId) {
  const channel = await resolveVoiceChannel(guild, channelId);
  if (!channel) {
    console.log(`[voice:${guild.id}] channel ${channelId} gak ada, stop`);
    removeGuildState(guild.id);
    destroyConnection(guild.id);
    return false;
  }

  let conn = getConn(guild.id);
  if (!conn) return freshJoin(guild, channel);

  const status = conn.state.status;
  const sameChannel = conn.joinConfig?.channelId === channel.id;

  if (sameChannel && status === VoiceConnectionStatus.Ready) {
    setTarget(guild.id, channel.id);
    return true;
  }

  if (status === VoiceConnectionStatus.Connecting || status === VoiceConnectionStatus.Signalling) {
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      setTarget(guild.id, channel.id);
      return true;
    } catch {}
    if (!getConn(guild.id)) return freshJoin(guild, channel);
  }

  conn = getConn(guild.id);
  if (conn) {
    const inChannel = await discordStillInChannel(guild.id, channel.id);
    console.log(
      `[voice:${guild.id}] reuse koneksi (discord_state=${inChannel === null ? "unknown" : inChannel})`
    );
    try {
      conn.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
      await entersState(conn, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      setTarget(guild.id, channel.id);
      console.log(`[voice:${guild.id}] rejoin tanpa destroy -> ${channel.name}`);
      return true;
    } catch (e) {
      console.error(`[voice:${guild.id}] rejoin gagal, koneksi baru`, e?.message ?? e);
    }
  }

  return freshJoin(guild, channel);
}

function connectGuild(guild, channelId) {
  const prev = joinChains.get(guild.id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => ensureConnected(guild, channelId));
  joinChains.set(guild.id, next.catch(() => {}));
  return next;
}

function onDisconnected(guildId, code) {
  if (!state[guildId]) return;
  console.log(`[voice:${guildId}] terputus (code=${code ?? "?"}), cek status dulu...`);
  scheduleRejoin(guildId);
}

async function scheduleRejoin(guildId) {
  if (rejoining.has(guildId)) return;
  rejoining.add(guildId);
  try {
    while (state[guildId]) {
      const status = connectionStatus(guildId);
      if (status === VoiceConnectionStatus.Ready) return;

      const s = state[guildId];
      const guild = client?.guilds?.cache?.get(guildId);
      if (!guild) {
        await sleep(REJOIN_DELAY_MS);
        continue;
      }

      const inChannel = await discordStillInChannel(guildId, s.channelId);
      if (inChannel === true) {
        console.log(`[voice:${guildId}] discord masih anggap di channel, coba rejoin ringan`);
      } else if (inChannel === false) {
        console.log(`[voice:${guildId}] udah gak di channel, rejoin`);
      }

      if (await connectGuild(guild, s.channelId)) return;
      await sleep(REJOIN_DELAY_MS);
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
  setTarget(guild.id, channel.id);
  const ok = await connectGuild(guild, channel.id);
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
  const inVc = connectionStatus(guild.id) === VoiceConnectionStatus.Ready;
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

async function restoreTargets(c) {
  for (const guildId of Object.keys(state)) {
    let guild = c.guilds.cache.get(guildId) ?? null;
    if (!guild) {
      try {
        guild = await c.guilds.fetch(guildId);
      } catch (e) {
        if (isUnknownError(e, UNKNOWN_GUILD)) {
          console.log(`[state] guild ${guildId} gak ada, buang dari state`);
          removeGuildState(guildId);
          continue;
        }
        console.log(`[state] guild ${guildId} belum kebaca, coba lagi nanti`);
        scheduleRejoin(guildId);
        continue;
      }
    }
    if (!(await connectGuild(guild, state[guildId].channelId))) scheduleRejoin(guildId);
  }
  saveState();
}

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

    await restoreTargets(c);
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
    if (interaction.commandName === "join") {
      await doJoin(interaction.guild, interaction.member?.voice?.channel, reply);
    } else if (interaction.commandName === "leave") {
      await doLeave(interaction.guild, reply);
    } else if (interaction.commandName === "status") {
      await doStatus(interaction.guild, reply);
    }
  });

  c.on("voiceStateUpdate", (oldState, newState) => {
    const member = newState.member ?? oldState.member;
    if (!member || member.id !== c.user.id) return;
    const guildId = member.guild.id;
    const s = state[guildId];
    if (!s) return;
    if (newState.channelId && newState.channelId !== s.channelId) {
      console.log(`[voice:${guildId}] bot dipindah, balikin ke target`);
      connectGuild(member.guild, s.channelId).then((ok) => {
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
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

start(FULL_INTENTS);
