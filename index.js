const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');
const fs = require('fs');

// --- KONFIGURASI ---
const BASE_URL = 'https://maknaflow-staging.onrender.com/api';
const SESSION_DIR = 'auth_baileys'; 
const CONTACTS_FILE = 'contacts_mapping.json'; // File database manual kita
// Tambahan QR dijadikan kode
const usePairingCode = true; // Ubah jadi false jika ingin balik ke QR
const nomorBot = '628211019477'; // NOMOR BOT WHATSAPP ANDA

// State Management
const userSessions = {};
let MASTER_DATA = null;
let LID_MAPPING = {}; // Cache di RAM

// --- FUNGSI LOAD/SAVE KONTAK MANUAL ---
function loadContacts() {
    if (fs.existsSync(CONTACTS_FILE)) {
        try {
            const raw = fs.readFileSync(CONTACTS_FILE, 'utf-8');
            LID_MAPPING = JSON.parse(raw);
            console.log(`📂 Memuat ${Object.keys(LID_MAPPING).length} kontak terdaftar.`);
        } catch (e) {
            console.error("⚠️ Gagal baca file kontak:", e);
        }
    }
}

function saveContact(lid, phone) {
    LID_MAPPING[lid] = phone;
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(LID_MAPPING, null, 2));
    console.log(`💾 Kontak disimpan: ${lid} -> ${phone}`);
}

// Load kontak saat start
loadContacts();

// --- FUNGSI UPDATE DATA ---
async function fetchMasterData() {
    try {
        console.log("🔄 Mengambil data terbaru dari Django...");
        const response = await axios.get(`${BASE_URL}/bot/master-data/`);
        MASTER_DATA = response.data;
        console.log(`✅ Data Master Terupdate: ${MASTER_DATA.branches.length} Cabang, ${MASTER_DATA.categories.length} Kategori.`);
    } catch (error) {
        console.error("❌ Gagal ambil data master:", error.message);
    }
}

// --- FUNGSI UTAMA BOT ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: !usePairingCode,
        logger: pino({ level: 'silent' }),
        browser: ['MaknaFlow Bot', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
    });

    // --- LOGIKA PAIRING CODE ---
    if (usePairingCode && !sock.authState.creds.registered) {
        console.log(`⏳ Menunggu request Pairing Code untuk nomor: ${nomorBot}...`);
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(nomorBot);
                console.log(`\n================================================`);
                console.log(`🌟 KODE PAIRING ANDA: ${code}`);
                console.log(`================================================\n`);
                console.log(`👉 Buka WA di HP > Linked Devices > Link a Device > Link with phone number instead.`);
            } catch (err) {
                console.error('Gagal request pairing code:', err);
            }
        }, 5000); // Tunggu 5 detik biar siap
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairingCode) {
            // Hanya tampilkan QR jika mode Pairing Code dimatikan
            console.log('📌 Scan QR Code di bawah ini:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Koneksi terputus. Reconnect otomatis...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('❌ Logout. Hapus folder auth_baileys untuk login ulang.');
            }
        } else if (connection === 'open') {
            console.log('🚀 Bot Siap & Terhubung Stabil (Mode Pairing)!');
            await fetchMasterData();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        // --- 1. IDENTIFIKASI PENGIRIM ---
        let rawSender = msg.key.remoteJid;
        
        // Cek apakah pesan ini dari Staff (via LID/Private ID)
        if (msg.key.remoteJid.endsWith('@lid') || msg.key.participant?.endsWith('@lid')) {
             // Ambil ID LID-nya
             rawSender = msg.key.remoteJid.endsWith('@lid') ? msg.key.remoteJid : msg.key.participant;
        }

        rawSender = jidNormalizedUser(rawSender); // Format: 2566xxx@lid
        let finalSender = rawSender;

        // Cek Mapping Manual
        if (LID_MAPPING[rawSender]) {
            finalSender = LID_MAPPING[rawSender]; // Ubah jadi 628xxx
            // console.log(`🔍 Translate ID: ${rawSender} -> ${finalSender}`);
        } else {
            // Jika belum ada di mapping, coba ambil nomor biasa jika formatnya sudah nomor
            finalSender = finalSender.split('@')[0];
        }
        
        // Bersihkan finalSender agar hanya angka (jika format 628xxx@s.whatsapp.net)
        if (finalSender.includes('@')) {
            finalSender = finalSender.split('@')[0];
        }

        // Helper Reply
        const reply = async (txt) => {
            await sock.sendMessage(msg.key.remoteJid, { text: txt }, { quoted: msg });
        };

        const messageContent = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!messageContent) return;
        const text = messageContent.trim();
        
        console.log(`📩 Pesan dari ${finalSender} (Raw: ${rawSender}): "${text}"`);

        // --- 2. FITUR REGISTRASI MANUAL (/iam) ---
        // Jika Staff mengetik: /iam 628211019477
        if (text.toLowerCase().startsWith('/iam ')) {
            const inputNumber = text.split(' ')[1];
            if (!inputNumber || isNaN(inputNumber)) {
                await reply('❌ Format salah.\nGunakan: */iam 628xxxxxxxx*');
                return;
            }
            
            // Simpan Mapping: LID -> Nomor HP
            saveContact(rawSender, inputNumber);
            await reply(`✅ Berhasil! Bot sekarang mengenali Anda sebagai: *${inputNumber}*\nSilakan ketik /lapor untuk memulai.`);
            return;
        }

        // --- LOGIC REFRESH ---
        if (text === '/refresh') {
            await fetchMasterData();
            await reply('✅ Data Database Django diperbarui!');
            return;
        }

        // --- LOGIC LAPOR ---
        if (!userSessions[finalSender]) {
            if (text.toLowerCase() === '/lapor') {
                
                // Cek apakah nomor ini terdaftar (Apakah mapping berhasil?)
                // Jika masih berupa LID (2566...), tolak!
                if (finalSender.startsWith('2566') || finalSender.length > 15) {
                    await reply('⚠️ Bot belum mengenali nomor asli Anda.\n\nKetik: */iam <NomorHPAnda>*\nContoh: */iam 628211019477*');
                    return;
                }

                if (!MASTER_DATA || !MASTER_DATA.branches) {
                    await fetchMasterData();
                    if (!MASTER_DATA) {
                        await reply('❌ Gagal menghubungi server.');
                        return;
                    }
                }
                userSessions[finalSender] = { step: 1, data: { phone_number: finalSender } };
                await reply('Halo Staff! Pilih Unit Bisnis:\n1. Laundry\n2. Carwash\n3. Kos');
            }
        } else {
            const session = userSessions[finalSender];

            if (text.toLowerCase() === 'batal') {
                delete userSessions[finalSender];
                await reply('🚫 Transaksi dibatalkan.');
                return;
            }

            switch (session.step) {
                case 1: 
                    let selectedType = '';
                    if (text === '1') selectedType = 'LAUNDRY';
                    else if (text === '2') selectedType = 'CARWASH';
                    else if (text === '3') selectedType = 'KOS';

                    if (!selectedType) { await reply('❌ Pilihan salah.'); return; }

                    const filteredBranches = MASTER_DATA.branches.filter(b => b.branch_type === selectedType);
                    if (filteredBranches.length === 0) {
                        await reply(`❌ Belum ada cabang ${selectedType}.`);
                        delete userSessions[finalSender];
                        return;
                    }
                    session.temp_branches = filteredBranches;
                    let menuText = `🏢 Pilih Cabang ${selectedType}:\n`;
                    filteredBranches.forEach((branch, index) => {
                        menuText += `${index + 1}. ${branch.name}\n`;
                    });
                    session.step = 2;
                    await reply(menuText);
                    break;

                case 2:
                    const branchIndex = parseInt(text) - 1;
                    if (session.temp_branches && session.temp_branches[branchIndex]) {
                        session.data.branch_id = session.temp_branches[branchIndex].id;
                        session.data.branch_name = session.temp_branches[branchIndex].name;
                        session.step = 3;
                        await reply(`✅ Cabang *${session.data.branch_name}* terpilih.\n\n💰 Tipe:\n1. INCOME\n2. EXPENSE`);
                    } else { await reply('❌ Nomor cabang tidak valid.'); }
                    break;

                case 3:
                    const types = { '1': 'INCOME', '2': 'EXPENSE' };
                    if (types[text]) {
                        session.data.type = types[text];
                        session.step = 4;
                        const filteredCats = MASTER_DATA.categories.filter(c => c.transaction_type === types[text]);
                        if (filteredCats.length === 0) { await reply('❌ Kategori kosong.'); return; }
                        session.temp_cats = filteredCats;
                        let catMenu = `📂 Pilih Kategori ${types[text]}:\n`;
                        filteredCats.forEach((cat, index) => {
                            catMenu += `${index + 1}. ${cat.name}\n`;
                        });
                        await reply(catMenu);
                    } else { await reply('❌ Pilihan salah.'); }
                    break;

                case 4:
                    const catIndex = parseInt(text) - 1;
                    if (session.temp_cats && session.temp_cats[catIndex]) {
                        session.data.category_id = session.temp_cats[catIndex].id;
                        session.data.category_name = session.temp_cats[catIndex].name;
                        session.step = 5;
                        await reply(`Kategori: *${session.data.category_name}*\n\n💵 Masukkan Nominal (Angka):`);
                    } else { await reply('❌ Nomor kategori tidak valid.'); }
                    break;

                case 5:
                    const cleanAmount = text.replace(/[^0-9]/g, '');
                    if (cleanAmount && !isNaN(cleanAmount)) {
                        session.data.amount = parseInt(cleanAmount);
                        session.step = 6;
                        await reply('📝 Ada catatan? (Ketik "-" jika tidak ada)');
                    } else { await reply('❌ Harap masukkan angka valid.'); }
                    break;

                case 6:
                    session.data.notes = text;
                    await reply('⏳ Mengirim data ke server...');
                    
                    try {
                        const payload = {
                            phone_number: session.data.phone_number,
                            branch_id: session.data.branch_id,
                            category_id: session.data.category_id,
                            type: session.data.type,
                            amount: session.data.amount,
                            notes: session.data.notes
                        };

                        const response = await axios.post(`${BASE_URL}/ingestion/internal-wa/`, payload);

                        // --- FORMAT WAKTU (WIB) ---
                        // Kita paksa Timezone Asia/Jakarta agar jamnya sesuai WIB (bukan jam server London/USA)
                        const now = new Date();
                        const optionsDate = { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'long', year: 'numeric' };
                        const optionsTime = { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false };
                        
                        const tgl = now.toLocaleDateString('id-ID', optionsDate);
                        const jam = now.toLocaleTimeString('id-ID', optionsTime);

                        // Coba cari ID
                        const trxId = response.data.id || response.data.pk || response.data.transaction_id || response.data.data?.id || "Pending";

                        // Coba cari Metode Pembayaran, kalo nggak ada default ke Tunai
                        const payMethod = response.data.payment_method || "TUNAI (CASH)";

                        // --- STRUK DIGITAL LENGKAP ---
                        const struk = `✅ *TRANSAKSI BERHASIL DICATAT*\n` +
                                      `--------------------------------\n` +
                                      `🆔 *ID:* ${trxId}\n` +
                                      `📅 *Tanggal:* ${tgl}\n` +
                                      `⏰ *Waktu:* ${jam} WIB\n` +
                                      `🏢 *Cabang:* ${session.data.branch_name}\n` +
                                      `📂 *Kategori:* ${session.data.category_name}\n` +
                                      `🔄 *Tipe:* ${session.data.type}\n` +
                                      `💳 *Metode:* ${payMethod}\n` +
                                      `💰 *Nominal:* Rp ${session.data.amount.toLocaleString('id-ID')}\n` +
                                      `📝 *Catatan:* ${session.data.notes}\n` +
                                      `--------------------------------\n` +
                                      `Data sudah masuk ke Dashboard Admin.`;

                        await reply(struk);

                    } catch (error) {
                        console.error('API Error:', error.message);
                        
                        // Ambil pesan error asli dari Django
                        let rawError = error.response?.data?.detail || error.response?.data?.error || JSON.stringify(error.response?.data) || error.message;
                        
                        let humanMessage = "";

                        // --- LOGIKA PENERJEMAH ERROR ---
                        if (rawError.includes('duplicate key') || rawError.includes('unique constraint')) {
                            // 1. JIKA DUPLIKAT
                            humanMessage = "⚠️ *GAGAL: DATA DUPLIKAT*\n\nTransaksi ini sepertinya sudah pernah diinput sebelumnya (Nominal, Kategori & Cabang sama persis). Sistem menolak input ganda.";
                        
                        } else if (error.response?.status === 404) {
                            // 2. JIKA USER BELUM ASSIGN CABANG
                            humanMessage = `❌ *Akses Ditolak*\n\nNomor HP Anda (${session.data.phone_number}) belum terdaftar atau belum di-assign ke Cabang ini di Admin. Hubungi Owner.`;
                        
                        } else {
                            // 3. ERROR LAINNYA
                            humanMessage = `❌ *Gagal Mencatat Transaksi*\n\nTeknis: ${rawError}`;
                        }

                        await reply(humanMessage);
                    }
                    
                    delete userSessions[finalSender];
                    break;
            }
        }
    });
}

connectToWhatsApp();