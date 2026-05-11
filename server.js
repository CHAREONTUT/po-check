require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { google } = require('googleapis')
const path = require('path')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname)))

// ── Google Sheets Auth ──────────────────────────────────────────
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })
}

const SHEET_ID = process.env.SPREADSHEET_ID

// ── Helper: read sheet ──────────────────────────────────────────
async function readSheet(range) {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  })
  return res.data.values || []
}

// ── Helper: append row ──────────────────────────────────────────
async function appendRow(sheet, row) {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  })
}

// ══════════════════════════════════════════════════════════════════
// ROUTES — PO
// ══════════════════════════════════════════════════════════════════
app.get('/api/po', async (req, res) => {
  try {
    const rows = await readSheet('PO_MASTER!A2:J')
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/po', async (req, res) => {
  try {
    const { poNum, project, client, startDate, endDate, value, note } = req.body
    if (!poNum || !project || !startDate || !endDate)
      return res.status(400).json({ ok: false, error: 'กรุณากรอกข้อมูลที่จำเป็น' })
    const now = new Date().toLocaleDateString('th-TH')
    await appendRow('PO_MASTER', [poNum, project, client, startDate, endDate, value, 'ใช้งาน', note, now, 'Admin'])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ══════════════════════════════════════════════════════════════════
// ROUTES — EMPLOYEES
// ══════════════════════════════════════════════════════════════════
app.get('/api/employees', async (req, res) => {
  try {
    const rows = await readSheet('พนักงาน!A2:H')
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/api/employees/:po', async (req, res) => {
  try {
    const rows = await readSheet('พนักงาน!A2:H')
    const filtered = rows.filter(r => r[0] === req.params.po)
    res.json({ ok: true, data: filtered })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/employees', async (req, res) => {
  try {
    const { poNum, empId, name, position, dept, rate } = req.body
    if (!poNum || !empId || !name)
      return res.status(400).json({ ok: false, error: 'กรุณากรอกข้อมูลที่จำเป็น' })
    const now = new Date().toLocaleDateString('th-TH')
    await appendRow('พนักงาน', [poNum, empId, name, position, dept, rate, now, ''])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ══════════════════════════════════════════════════════════════════
// ROUTES — OT
// ══════════════════════════════════════════════════════════════════
app.get('/api/ot', async (req, res) => {
  try {
    const rows = await readSheet('OT!A2:J')
    res.json({ ok: true, data: rows })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/ot', async (req, res) => {
  try {
    const { poNum, empId, empName, poOt, otDate, otPay, otBill } = req.body
    if (!poNum || !empId || !poOt || !otDate || !otPay || !otBill)
      return res.status(400).json({ ok: false, error: 'กรุณากรอกข้อมูลให้ครบ' })
    const profit = Number(otBill) - Number(otPay)
    const month = otDate.slice(0, 7)
    await appendRow('OT', [poNum, empId, empName, poOt, otDate, otPay, otBill, profit, month, 'Admin'])
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ══════════════════════════════════════════════════════════════════
// ROUTES — ALERTS (computed server-side)
// ══════════════════════════════════════════════════════════════════
app.get('/api/alerts', async (req, res) => {
  try {
    const rows = await readSheet('PO_MASTER!A2:J')
    const today = new Date()
    const alerts = rows
      .map(r => {
        const end = new Date(r[4])
        const diff = Math.ceil((end - today) / 86400000)
        return { po: r[0], project: r[1], client: r[2], endDate: r[4], daysLeft: diff }
      })
      .filter(a => a.daysLeft >= 0 && a.daysLeft <= 14)
      .sort((a, b) => a.daysLeft - b.daysLeft)
    res.json({ ok: true, data: alerts })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Health check ────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, message: 'PO System running 🚀' }))

// ── Catch-all → serve frontend ──────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`✅ PO System running on port ${PORT}`))
