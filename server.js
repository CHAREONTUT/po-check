require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { google } = require('googleapis')
const path = require('path')
const crypto = require('crypto')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname)))

const SHEET_ID   = process.env.SPREADSHEET_ID
const JWT_SECRET = process.env.JWT_SECRET || 'po-check-secret-2024'

// ── 3 fixed users (เก็บใน env หรือ hardcode) ─────────────────
const USERS = [
  { name: process.env.USER1_NAME  || 'ปอ Admin',   email: process.env.USER1_EMAIL || 'po@company.com',    password: process.env.USER1_PASS || 'po1234' },
  { name: process.env.USER2_NAME  || 'ผู้ใช้ 2',   email: process.env.USER2_EMAIL || 'user2@company.com', password: process.env.USER2_PASS || 'user1234' },
  { name: process.env.USER3_NAME  || 'ผู้ใช้ 3',   email: process.env.USER3_EMAIL || 'user3@company.com', password: process.env.USER3_PASS || 'user1234' },
]

// ── JWT ───────────────────────────────────────────────────────
function signToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url')
  const b = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 7*24*60*60*1000 })).toString('base64url')
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')
  return `${h}.${b}.${s}`
}
function verifyToken(token) {
  try {
    const [h,b,s] = token.split('.')
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')
    if (s !== expected) return null
    const payload = JSON.parse(Buffer.from(b,'base64url').toString())
    if (payload.exp < Date.now()) return null
    return payload
  } catch { return null }
}
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ','')
  if (!token) return res.status(401).json({ ok:false, error:'กรุณาเข้าสู่ระบบ' })
  const p = verifyToken(token)
  if (!p) return res.status(401).json({ ok:false, error:'Session หมดอายุ' })
  req.user = p; next()
}

// ── Google Sheets ─────────────────────────────────────────────
function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  return new google.auth.GoogleAuth({ credentials, scopes:['https://www.googleapis.com/auth/spreadsheets'] })
}
async function readSheet(range) {
  const sheets = google.sheets({ version:'v4', auth: getGoogleAuth() })
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range })
  return res.data.values || []
}
async function appendRow(sheet, row) {
  const sheets = google.sheets({ version:'v4', auth: getGoogleAuth() })
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID, range:`${sheet}!A1`,
    valueInputOption:'USER_ENTERED', requestBody:{ values:[row] }
  })
}

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ ok:false, error:'กรุณากรอก Email และ Password' })
  const user = USERS.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password)
  if (!user) return res.status(401).json({ ok:false, error:'Email หรือ Password ไม่ถูกต้อง' })
  const token = signToken({ name:user.name, email:user.email })
  res.json({ ok:true, token, user:{ name:user.name, email:user.email } })
})

app.get('/api/auth/me', auth, (req, res) => res.json({ ok:true, user:req.user }))

// ══════════════════════════════════════════════════════════════
// PO
// ══════════════════════════════════════════════════════════════
app.get('/api/po', auth, async (req, res) => {
  try { res.json({ ok:true, data: await readSheet('PO_MASTER!A2:Z') }) }
  catch(e) { res.status(500).json({ ok:false, error:e.message }) }
})

// POST /api/po — บันทึก PO + พนักงานสูงสุด 30 คนในแถวเดียว
// columns: เลข PO | ชื่อลูกค้า | วันเริ่ม | วันสิ้นสุด | พนักงาน1 | พนักงาน2 | ... | พนักงาน30 | บันทึกโดย | วันที่บันทึก
app.post('/api/po', auth, async (req, res) => {
  try {
    const { poNum, client, startDate, endDate, employees } = req.body
    if (!poNum || !client) return res.status(400).json({ ok:false, error:'กรุณากรอกเลข PO และชื่อลูกค้า' })
    const empList = (employees || []).filter(e => e.trim()).slice(0, 30)
    const empPadded = [...empList, ...Array(30).fill('')].slice(0, 30)
    const now = new Date().toLocaleDateString('th-TH')
    await appendRow('PO_MASTER', [poNum, client, startDate||'', endDate||'', ...empPadded, req.user.name, now])
    res.json({ ok:true })
  } catch(e) { res.status(500).json({ ok:false, error:e.message }) }
})

// GET employees in a PO
app.get('/api/po/:poNum/employees', auth, async (req, res) => {
  try {
    const rows = await readSheet('PO_MASTER!A2:Z')
    const row = rows.find(r => r[0] === req.params.poNum)
    if (!row) return res.json({ ok:true, data:[] })
    // cols 4–33 = employees
    const employees = row.slice(4, 34).filter(e => e && e.trim())
    res.json({ ok:true, poNum:row[0], client:row[1], startDate:row[2], endDate:row[3], data:employees })
  } catch(e) { res.status(500).json({ ok:false, error:e.message }) }
})

// ══════════════════════════════════════════════════════════════
// OT
// ══════════════════════════════════════════════════════════════
app.get('/api/ot', auth, async (req, res) => {
  try { res.json({ ok:true, data: await readSheet('OT!A2:J') }) }
  catch(e) { res.status(500).json({ ok:false, error:e.message }) }
})

// columns: เลข PO(อาจว่าง) | ชื่อพนักงาน | เลข PO_OT | วันที่ออกเอกสาร | OT จ่ายพนักงาน | OT เรียกเก็บลูกค้า | กำไร | เดือน | บันทึกโดย
app.post('/api/ot', auth, async (req, res) => {
  try {
    const { poNum, empName, poOt, docDate, otPay, otBill } = req.body
    if (!empName || !poOt || !docDate || !otPay || !otBill)
      return res.status(400).json({ ok:false, error:'กรุณากรอกข้อมูลให้ครบ' })
    const profit = Number(otBill) - Number(otPay)
    const month  = docDate.slice(0,7)
    await appendRow('OT', [poNum||'', empName, poOt, docDate, otPay, otBill, profit, month, req.user.name])
    res.json({ ok:true })
  } catch(e) { res.status(500).json({ ok:false, error:e.message }) }
})

// ══════════════════════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════════════════════
app.get('/api/alerts', auth, async (req, res) => {
  try {
    const rows = await readSheet('PO_MASTER!A2:E')
    const today = new Date()
    const alerts = rows
      .map(r => ({ po:r[0], client:r[1], endDate:r[3], daysLeft:Math.ceil((new Date(r[3])-today)/86400000) }))
      .filter(a => a.endDate && a.daysLeft >= 0 && a.daysLeft <= 14)
      .sort((a,b) => a.daysLeft - b.daysLeft)
    res.json({ ok:true, data:alerts })
  } catch(e) { res.status(500).json({ ok:false, error:e.message }) }
})

app.get('/api/health', (req,res) => res.json({ ok:true }))
app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'index.html')))

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`✅ PO System running on port ${PORT}`))
