// Bot feito por @Xesteer
// Expulsa contas mortas/falsas que nunca ficaram online + /lista everOnline
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const config = require('./config.json');

const DB_PATH = path.join(__dirname, 'database.json');
const CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutos

// ---------- Database JSON ----------
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.everOnline)) db.everOnline = [];
    if (!Array.isArray(db.neverOnline)) db.neverOnline = [];
    if (!('lastCheck' in db)) db.lastCheck = null;
    return db;
  } catch {
    return { everOnline: [], neverOnline: [], lastCheck: null };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadDB();

// ---------- Client ----------
// ATENÇÃO: ative "Server Members Intent" e "Presence Intent" no Developer Portal
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ]
});

// ---------- Verificação a cada 30 min ----------
async function verificarMembros() {
  const doDisco = loadDB();
  const everOnlineSet = new Set([...(db.everOnline || []), ...(doDisco.everOnline || [])]);
  const neverOnlineSet = new Set(doDisco.neverOnline || []);
  for (const id of everOnlineSet) neverOnlineSet.delete(id);

  const novosMortos = new Set();
  let totalVistos = 0;
  let comPresence = 0;
  let onlineAchados = 0;

  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch({ withPresences: true });

      members.forEach((member) => {
        if (member.user.bot) return;
        totalVistos++;

        if (member.presence) comPresence++;

        const status = member.presence?.status || 'offline';
        const isOnline = status === 'online' || status === 'idle' || status === 'dnd';

        if (isOnline) {
          onlineAchados++;
          everOnlineSet.add(member.id);
          neverOnlineSet.delete(member.id);
          novosMortos.delete(member.id);
        } else {
          if (!everOnlineSet.has(member.id) && !neverOnlineSet.has(member.id)) {
            novosMortos.add(member.id);
          }
        }
      });
    } catch (err) {
      console.error(`[ERRO] Falha ao verificar guild ${guild.name}:`, err.message);
    }
  }

  // Trava anti-reset: sem presence nenhuma, não marca ninguém
  if (totalVistos > 0 && comPresence === 0) {
    console.error('[WARN] Nenhuma presence recebida! Ative o Presence Intent. Check ignorado.');
    db.everOnline = [...everOnlineSet];
    db.neverOnline = [...neverOnlineSet];
    db.lastCheck = new Date().toISOString();
    saveDB(db);
    return;
  }

  for (const id of novosMortos) {
    if (!everOnlineSet.has(id)) neverOnlineSet.add(id);
  }
  for (const id of everOnlineSet) neverOnlineSet.delete(id);

  db.everOnline = [...everOnlineSet];
  db.neverOnline = [...neverOnlineSet];
  db.lastCheck = new Date().toISOString();
  saveDB(db);

  console.log(`[CHECK ${db.lastCheck}] vistos: ${totalVistos} | comPresence: ${comPresence} | online agora: ${onlineAchados} | everOnline: ${db.everOnline.length} | neverOnline: ${db.neverOnline.length}`);
}

// ---------- Slash commands ----------
const expulsarCommand = new SlashCommandBuilder()
  .setName('expulsar')
  .setDescription('Expulsa todas as contas que nunca ficaram online (neverOnline)');

const listaCommand = new SlashCommandBuilder()
  .setName('lista')
  .setDescription('Lista os usuários que já ficaram online alguma vez (everOnline)');

async function registrarComando() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    await rest.put(Routes.applicationCommands(config.clientId), {
      body: [expulsarCommand.toJSON(), listaCommand.toJSON()]
    });
    console.log('[OK] Comandos /expulsar e /lista registrados.');
  } catch (err) {
    console.error('[ERRO] Falha ao registrar comandos:', err.message);
  }
}

// Marca alguém como everOnline na hora
function marcarOnline(userId) {
  if (!userId) return;
  db = loadDB();
  let mudou = false;
  if (!db.everOnline.includes(userId)) {
    db.everOnline.push(userId);
    mudou = true;
  }
  const antes = db.neverOnline.length;
  db.neverOnline = db.neverOnline.filter((id) => id !== userId);
  if (db.neverOnline.length !== antes) mudou = true;
  if (mudou) {
    saveDB(db);
    console.log(`[PRESENCE] ${userId} ficou online -> everOnline.`);
  }
}

client.on('presenceUpdate', (oldPresence, newPresence) => {
  if (!newPresence || !newPresence.user || newPresence.user.bot) return;
  const status = newPresence.status || 'offline';
  if (status === 'online' || status === 'idle' || status === 'dnd') {
    marcarOnline(newPresence.userId);
  }
});

client.once('clientReady', async () => {
  console.log(`[ON] Logado como ${client.user.tag}`);
  console.log('[CREDITOS] Bot feito por @Xesteer');
  await registrarComando();
  await verificarMembros();
  setInterval(verificarMembros, CHECK_INTERVAL);
  console.log('[OK] Verificação automática a cada 30 minutos ativada.');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.user.id !== config.allowedUserId) {
    return interaction.reply({ content: 'Você não tem permissão para usar este comando.', ephemeral: true });
  }

  // ---------- /lista: mostra os everOnline ----------
  if (interaction.commandName === 'lista') {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    if (!guild) {
      return interaction.editReply('Este comando só pode ser usado dentro de um servidor.');
    }

    db = loadDB();

    if (db.everOnline.length === 0) {
      return interaction.editReply('A lista everOnline está vazia.');
    }

    // Tenta buscar os membros para mostrar nome bonito, mas não falha se não achar
    let membrosCache = new Map();
    try {
      const fetched = await guild.members.fetch();
      fetched.forEach((m) => membrosCache.set(m.id, m));
    } catch (err) {
      console.error('[WARN] Falha ao buscar membros para /lista:', err.message);
    }

    const linhas = db.everOnline.map((id) => {
      const m = membrosCache.get(id);
      const nome = m ? (m.displayName || m.user.username) : 'Desconhecido';
      return `<@${id}> (${id}) — ${nome}`;
    });

    linhas.sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const header = `**Usuários everOnline (${linhas.length}):**\n`;
    const chunks = [];
    let atual = header;
    for (const linha of linhas) {
      if ((atual + linha + '\n').length > 2000) {
        chunks.push(atual);
        atual = '';
      }
      atual += linha + '\n';
    }
    if (atual.length > 0) chunks.push(atual);

    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], ephemeral: true });
    }
    return;
  }

  if (interaction.commandName !== 'expulsar') return;

  db = loadDB();

  if (db.neverOnline.length === 0) {
    return interaction.reply({ content: 'Nenhuma conta morta para expulsar. Lista vazia.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (!guild) {
    return interaction.editReply('Este comando só pode ser usado dentro de um servidor.');
  }

  let expulsos = 0;
  let falhas = 0;
  const restantes = [];
  const viraramOnline = [];

  for (const userId of [...db.neverOnline]) {
    // Se ficou online em algum momento, protege
    if (db.everOnline.includes(userId)) continue;

    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        // Já saiu do servidor -> apenas descarta
        continue;
      }

      // Se por acaso está online agora, protege (não expulsa)
      const status = member.presence?.status;
      if (status === 'online' || status === 'idle' || status === 'dnd') {
        viraramOnline.push(userId);
        continue;
      }

      // Expulsa independente de estar offline agora ou status desconhecido
      await member.kick('Conta morta/falsa: nunca ficou online');
      expulsos++;
    } catch (err) {
      console.error(`[ERRO] Falha ao expulsar ${userId}:`, err.message);
      falhas++;
      restantes.push(userId);
    }
  }

  // Merge final no banco
  db = loadDB();
  const everSet = new Set([...db.everOnline, ...viraramOnline]);
  const neverSet = new Set(restantes.filter((id) => !everSet.has(id)));

  db.everOnline = [...everSet];
  db.neverOnline = [...neverSet];
  saveDB(db);

  await interaction.editReply(
    `Expulsão concluída.\nExpulsos: ${expulsos}\nFalhas: ${falhas}\nRestantes na lista: ${restantes.length}`
  );
});

if (!config.token) {
  console.error('[ERRO] Configure seu token no config.json antes de iniciar.');
  process.exit(1);
}

process.on('unhandledRejection', (err) => console.error('[WARN] unhandledRejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('[WARN] uncaughtException:', err?.message || err));

client.login(config.token);