const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const axios = require('axios');

// ================= CONFIG & DATABASE =================
const BASE_URL = 'https://maknaflow-staging.onrender.com/api'; // Pastikan URL ini benar
const SESSION_DIR = 'auth_baileys';
const usePairingCode = false;
const nomorBot = '628211019477';

// ID Owner hanya digunakan untuk auto-reset session jika perlu, 
// tapi data staffnya sendiri sudah diambil dari API.
const ID_ADHIF = '50032124375122@lid'; 

// Database & Session Storage
let STAFF_DATABASE = {};
const userSession = {};
const SESSION_OWNER = {}; // Session untuk MULTI_CABANG (Owner/Agus/PIC)

// =========================================================
// 🌳 MENU & LIST CABANG
// =========================================================
// List ini digunakan saat user MULTI_CABANG perlu memilih unit.
// Idealnya list ini juga bisa diambil dari API, tapi hardcode di sini 
// untuk UI menu pilihan masih oke selama nama cabangnya SAMA PERSIS dengan di Database Django.

// 1. Menu Owner (Adhif)
const MENU_OWNER = {
    1: {
        nama: "Laundry",
        cabang: ["Laundry Bosku Babelan (Laundry Service)", "Laundry Bosku Kedaung (Laundry Service)", "MAVEN Laundry Rorotan (Laundry Service)", "MAVEN Laundry Rorotan 2 (Laundry Service)", "Laundry Blok A"]
    },
    2: { nama: "Car wash", cabang: ["Carwash Priok"] },
    3: { nama: "Parkiran", cabang: ["Parkiran Blok A"] },
    4: { nama: "Kosan", cabang: ["Kost-kostan Blok A", "Kost-kostan Cemput"] }
};

// 2. Menu Agus (Blok A)
const LIST_AGUS = [
    { nama: "Laundry Blok A", unit: "Laundry" },
    { nama: "Parkiran Blok A", unit: "Parkiran" },
    { nama: "Kost-kostan Blok A", unit: "Kost" }
];

// 3. Menu PIC Rorotan
const LIST_ROROTAN = [
    { nama: "MAVEN Laundry Rorotan (Laundry Service)", unit: "Laundry" },
    { nama: "MAVEN Laundry Rorotan 2 (Laundry Service)", unit: "Laundry" }
];

// ================= FUNGSI & LOGIC =================
async function fetchStaffData() {
    try {
        console.log("🔄 Menghubungkan ke Database Staff (Ultimate)...");
        // API ini sekarang sudah support Multi-Identity & Multi-Branch
        const response = await axios.get(`${BASE_URL}/bot/staff-list/`);
        STAFF_DATABASE = response.data;

        // =========================================================
        // 🚫 MANUAL INJECT DIHAPUS TOTAL 🚫
        // Django Admin sekarang adalah "Single Source of Truth".
        // =========================================================

        console.log(`✅ DATABASE TERHUBUNG! ${Object.keys(STAFF_DATABASE).length} staff/identitas siap.`);
    } catch (error) {
        console.error("❌ Gagal konek ke API Staff:", error.message);
    }
}

const formatRupiah = (angka) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(angka);
const getWaktu = () => {
    const now = new Date();
    return {
        date: now.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }),
        time: now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) + " WIB"
    };
};

async function kirimLaporanKeServer(noHp, dataLaporan) {
    try {
        console.log(`🚀 Mengirim Laporan: ${dataLaporan.cabang} oleh ${dataLaporan.nama}`);
        
        // Payload disesuaikan dengan Endpoint InternalWhatsAppIngestion di Django
        const payload = {
            phone_number: noHp,           // ID WA (Bisa @s.whatsapp.net atau @lid)
            branch_id: dataLaporan.cabang, // Nama Cabang (String)
            amount: 0,                    // Total Amount (Nanti dihitung per item atau total bersih)
            // KITA KIRIM DATA AGREGAT ATAU PER TRANSAKSI?
            // Untuk kesederhanaan saat ini, kita kirim 1 Transaksi "Rekap Closing"
            // Tapi idealnya API menerima array transaksi.
            // SEMENTARA: Kita kirim Total Pemasukan sebagai INCOME dan Pengeluaran sebagai EXPENSE secara terpisah.
        };

        // 1. Kirim Pemasukan CASH
        if (dataLaporan.in_cash > 0) {
            await axios.post(`${BASE_URL}/ingestion/internal-wa/`, {
                phone_number: noHp,
                branch_id: dataLaporan.cabang,
                type: 'INCOME',
                amount: dataLaporan.in_cash,
                notes: `[CASH] ${dataLaporan.note_income || 'Setoran Harian'}`
            });
        }
        
        // 2. Kirim Pemasukan QRIS
        if (dataLaporan.in_qris > 0) {
             await axios.post(`${BASE_URL}/ingestion/internal-wa/`, {
                phone_number: noHp,
                branch_id: dataLaporan.cabang,
                type: 'INCOME',
                amount: dataLaporan.in_qris,
                notes: `[QRIS] ${dataLaporan.note_income || 'Setoran Harian'}`
            });
        }

        // 3. Kirim Pemasukan TRANSFER
        if (dataLaporan.in_tf > 0) {
             await axios.post(`${BASE_URL}/ingestion/internal-wa/`, {
                phone_number: noHp,
                branch_id: dataLaporan.cabang,
                type: 'INCOME',
                amount: dataLaporan.in_tf,
                notes: `[TRANSFER] ${dataLaporan.note_income || 'Setoran Harian'}`
            });
        }

        // 4. Kirim Pengeluaran (EXPENSE)
        if (dataLaporan.out_expense > 0) {
            await axios.post(`${BASE_URL}/ingestion/internal-wa/`, {
                phone_number: noHp,
                branch_id: dataLaporan.cabang,
                type: 'EXPENSE',
                amount: dataLaporan.out_expense,
                notes: dataLaporan.note_expense || 'Pengeluaran Operasional'
            });
        }

        return true;
    } catch (error) {
        console.error("❌ Gagal kirim ke Server:", error.response?.data || error.message);
        return false;
    }
}

// ================= KONEKSI UTAMA =================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const sock = makeWASocket({
        auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"], connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000, emitOwnEvents: true,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr && !usePairingCode) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ BOT TERHUBUNG!');
            await fetchStaffData();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ================= HANDLING PESAN =================
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const noHp = jidNormalizedUser(msg.key.remoteJid);
            const pesan = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (noHp.includes(nomorBot)) return;

            console.log(`📩 Chat Masuk: ${noHp} | Isi: ${pesan}`);

            // Cek Database Staff (Dari API Django)
            const staffData = STAFF_DATABASE[noHp];
            if (!staffData) { 
                console.log(`⛔ Ditolak: Nomor ${noHp} tidak terdaftar di Django.`); 
                // Opsional: Reply "Nomor Anda tidak terdaftar" 
                return; 
            }

            // ============================================================
            // 🔄 FLOW MULTI-CABANG (OWNER / AGUS / PIC)
            // ============================================================
            
            // Trigger Reset jika ketik /lapor
            if (pesan.toLowerCase() === '/lapor' && staffData.cabang === 'MULTI_CABANG') {
                delete userSession[noHp]; 
                delete SESSION_OWNER[noHp]; // Reset sesi menu pilihan
            }

            // A. TAMPILKAN MENU UTAMA (Jika Multi Cabang & Belum Pilih)
            if (staffData.cabang === "MULTI_CABANG" && pesan.toLowerCase() === "/lapor") {
                // Deteksi Siapa ini berdasarkan Nama User di Django
                const namaUser = staffData.nama.toLowerCase();

                if (namaUser.includes("adhif") || namaUser.includes("abella")) {
                    // Menu Owner Adhif/Abella
                    let menu = "👑 *Menu Owner*\nMau lapor unit bisnis mana?\n\n";
                    Object.keys(MENU_OWNER).forEach((key) => { menu += `${key}. ${MENU_OWNER[key].nama}\n`; });
                    SESSION_OWNER[noHp] = { status: "WAITING_UNIT_OWNER" };
                    await sock.sendMessage(noHp, { text: menu + "\n_Ketik angka_" });

                } else if (namaUser.includes("agus")) {
                    // Menu Agus
                    let menu = `👋 Halo *${staffData.nama}* (Blok A).\nPilih Bisnis:\n\n`;
                    LIST_AGUS.forEach((item, idx) => { menu += `${idx + 1}. ${item.nama}\n`; });
                    SESSION_OWNER[noHp] = { status: "WAITING_CHOICE_AGUS" };
                    await sock.sendMessage(noHp, { text: menu + "\n_Ketik angka_" });

                } else if (namaUser.includes("pic") || namaUser.includes("rorotan")) {
                    // Menu PIC Rorotan
                    let menu = `👋 Halo *${staffData.nama}*.\nPilih Cabang Rorotan:\n\n`;
                    LIST_ROROTAN.forEach((item, idx) => { menu += `${idx + 1}. ${item.nama}\n`; });
                    SESSION_OWNER[noHp] = { status: "WAITING_CHOICE_ROROTAN" };
                    await sock.sendMessage(noHp, { text: menu + "\n_Ketik angka_" });
                } else {
                    // Default Multi Cabang (Jika ada user lain)
                    await sock.sendMessage(noHp, { text: "⚠️ Akun Anda Multi-Cabang tapi menu belum dikonfigurasi. Hubungi Admin." });
                }
                return;
            }

            // B. HANDLE PILIHAN MENU OWNER
            if (staffData.cabang === "MULTI_CABANG" && SESSION_OWNER[noHp]?.status === "WAITING_UNIT_OWNER") {
                const pilihan = parseInt(pesan);
                if (MENU_OWNER[pilihan]) {
                    let menuCabang = `📂 Unit: *${MENU_OWNER[pilihan].nama}*\nPilih Cabang:\n`;
                    MENU_OWNER[pilihan].cabang.forEach((cab, idx) => { menuCabang += `${idx + 1}. ${cab}\n`; });
                    SESSION_OWNER[noHp] = { status: "WAITING_BRANCH_OWNER", selectedUnit: MENU_OWNER[pilihan] };
                    await sock.sendMessage(noHp, { text: menuCabang + "\n_Ketik angka_" });
                } else { await sock.sendMessage(noHp, { text: "⛔ Pilihan salah." }); }
                return;
            }
            if (staffData.cabang === "MULTI_CABANG" && SESSION_OWNER[noHp]?.status === "WAITING_BRANCH_OWNER") {
                const idx = parseInt(pesan) - 1;
                const unit = SESSION_OWNER[noHp].selectedUnit;
                if (unit.cabang[idx]) {
                    const cabangFinal = unit.cabang[idx];
                    SESSION_OWNER[noHp] = { status: "READY", cabangAsli: cabangFinal }; // Set temporary branch
                    
                    // Mulai Flow Input
                    await sock.sendMessage(noHp, { text: `✅ Mode: *${cabangFinal}*\n\n1️⃣ Masukkan Total *Pemasukan CASH*:\n(Ketik 0 jika tidak ada)` });
                    userSession[noHp] = { step: 'INPUT_INCOME_CASH', data: { ...staffData, cabang: cabangFinal } };
                } else { await sock.sendMessage(noHp, { text: "⛔ Pilihan salah." }); }
                return;
            }

            // C. HANDLE PILIHAN MENU AGUS
            if (staffData.cabang === "MULTI_CABANG" && SESSION_OWNER[noHp]?.status === "WAITING_CHOICE_AGUS") {
                const idx = parseInt(pesan) - 1;
                if (LIST_AGUS[idx]) {
                    const pil = LIST_AGUS[idx];
                    SESSION_OWNER[noHp] = { status: "READY", cabangAsli: pil.nama };
                    
                    await sock.sendMessage(noHp, { text: `✅ Mode: *${pil.nama}*\n\n1️⃣ Masukkan Total *Pemasukan CASH*:\n(Ketik 0 jika tidak ada)` });
                    userSession[noHp] = { step: 'INPUT_INCOME_CASH', data: { ...staffData, cabang: pil.nama } };
                }
                return;
            }

            // D. HANDLE PILIHAN MENU ROROTAN
            if (staffData.cabang === "MULTI_CABANG" && SESSION_OWNER[noHp]?.status === "WAITING_CHOICE_ROROTAN") {
                const idx = parseInt(pesan) - 1;
                if (LIST_ROROTAN[idx]) {
                    const pil = LIST_ROROTAN[idx];
                    SESSION_OWNER[noHp] = { status: "READY", cabangAsli: pil.nama };

                    await sock.sendMessage(noHp, { text: `✅ Mode: *${pil.nama}*\n\n1️⃣ Masukkan Total *Pemasukan CASH*:\n(Ketik 0 jika tidak ada)` });
                    userSession[noHp] = { step: 'INPUT_INCOME_CASH', data: { ...staffData, cabang: pil.nama } };
                }
                return;
            }

            // ============================================================
            // 📝 LOGIKA INPUT LAPORAN (SEQUENTIAL)
            // ============================================================

            // Trigger Awal (Staff Biasa - Single Branch)
            if (pesan.toLowerCase() === '/lapor' && staffData.cabang !== "MULTI_CABANG") {
                userSession[noHp] = { step: 'INPUT_INCOME_CASH', data: staffData };
                await sock.sendMessage(noHp, { 
                    text: `🏢 *Laporan Closing: ${staffData.cabang}*\n\n1️⃣ Masukkan Total *Pemasukan CASH*:\n(Angka saja, misal: 100000)` 
                });
                return;
            }

            // HANDLE INPUT STEPS
            const session = userSession[noHp];
            if (session) {
                const cleanInput = pesan.replace(/[^0-9]/g, ''); 
                const nominal = cleanInput ? parseInt(cleanInput) : 0;

                // 1. CASH -> QRIS
                if (session.step === 'INPUT_INCOME_CASH') {
                    session.data.in_cash = nominal;
                    session.step = 'INPUT_INCOME_QRIS';
                    await sock.sendMessage(noHp, { text: `✅ Cash: ${formatRupiah(nominal)}\n\n2️⃣ Masukkan Total *Pemasukan QRIS*:\n(Ketik 0 jika tidak ada)` });
                    return;
                }
                // 2. QRIS -> TRANSFER
                if (session.step === 'INPUT_INCOME_QRIS') {
                    session.data.in_qris = nominal;
                    session.step = 'INPUT_INCOME_TRANSFER';
                    await sock.sendMessage(noHp, { text: `✅ QRIS: ${formatRupiah(nominal)}\n\n3️⃣ Masukkan Total *Pemasukan TRANSFER*:\n(Ketik 0 jika tidak ada)` });
                    return;
                }
                // 3. TRANSFER -> CATATAN PEMASUKAN
                if (session.step === 'INPUT_INCOME_TRANSFER') {
                    session.data.in_tf = nominal;
                    session.step = 'INPUT_CATATAN_INCOME';
                    await sock.sendMessage(noHp, { text: `✅ Transfer: ${formatRupiah(nominal)}\n\n📝 Ada *Catatan PEMASUKAN*?\n(Misal: "Selisih 500", "Customer Hutang". Ketik '-' jika aman)` });
                    return;
                }
                // 4. CATATAN INCOME -> EXPENSE
                if (session.step === 'INPUT_CATATAN_INCOME') {
                    session.data.note_income = pesan;
                    session.step = 'INPUT_EXPENSE';
                    await sock.sendMessage(noHp, { text: `✅ Catatan Pemasukan Tersimpan.\n\n4️⃣ Masukkan Total *PENGELUARAN* (Expense):\n(Operasional, belanja, dll. Ketik 0 jika nihil)` });
                    return;
                }
                // 5. EXPENSE -> CATATAN PENGELUARAN
                if (session.step === 'INPUT_EXPENSE') {
                    session.data.out_expense = nominal;
                    session.step = 'INPUT_CATATAN_EXPENSE';
                    await sock.sendMessage(noHp, { text: `✅ Expense: ${formatRupiah(nominal)}\n\n📝 Tulis Rincian *Catatan PENGELUARAN*:\n(Misal: "Beli Sabun 50rb, Sampah 20rb". Ketik '-' jika tidak ada)` });
                    return;
                }

                // 6. FINALISASI & KIRIM KE SERVER
                if (session.step === 'INPUT_CATATAN_EXPENSE') {
                    session.data.note_expense = pesan;
                    const { date, time } = getWaktu();
                    
                    const totalMasuk = (session.data.in_cash || 0) + (session.data.in_qris || 0) + (session.data.in_tf || 0);
                    const bersih = totalMasuk - (session.data.out_expense || 0);

                    // --- KIRIM KE SERVER DJANGO ---
                    await sock.sendMessage(noHp, { text: "⏳ Sedang mengirim data ke server..." });
                    const sukses = await kirimLaporanKeServer(noHp, session.data);

                    if (sukses) {
                        const struk = `✅ *LAPORAN CLOSING DITERIMA & TERSIMPAN*
--------------------------------
📅 *Tanggal:* ${date}
⏰ *Waktu:* ${time}
🏢 *Cabang:* ${session.data.cabang}
👤 *Pelapor:* ${session.data.nama}

*RINCIAN PEMASUKAN:*
💵 Cash: ${formatRupiah(session.data.in_cash)}
📱 QRIS: ${formatRupiah(session.data.in_qris)}
💳 Transfer: ${formatRupiah(session.data.in_tf)}
📝 *Note:* ${session.data.note_income}
--------------------------------
➕ *Total Omset:* ${formatRupiah(totalMasuk)}

*PENGELUARAN:*
🔻 Expense: ${formatRupiah(session.data.out_expense)}
📝 *Note:* ${session.data.note_expense}
--------------------------------
💰 *SETORAN BERSIH:* ${formatRupiah(bersih)}
--------------------------------
Data telah aman di Database Server.`;
                        await sock.sendMessage(noHp, { text: struk });
                    } else {
                        await sock.sendMessage(noHp, { text: "⚠️ Data tercatat di Chat tapi *GAGAL* masuk Server. Hubungi Admin." });
                    }

                    // Reset Session
                    delete userSession[noHp];
                    delete SESSION_OWNER[noHp];
                }
            }

        } catch (error) {
            console.error("Error handler:", error);
        }
    });
}

connectToWhatsApp();

// =========================================================
// 🔌 SERVER PEMANCING (DUMMY SERVER) UNTUK RENDER
// =========================================================
// Wajib ada agar Render tidak mematikan service (Error: Port Binding)
// dan agar bisa di-ping oleh UptimeRobot.

const http = require('http');
const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('MANTAP! Bot WhatsApp Maknaflow Sedang Berjalan 24/7. Jangan dimatikan!');
});

server.listen(port, () => {
    console.log(`✅ SERVER DUMMY BERJALAN DI PORT: ${port}`);
});