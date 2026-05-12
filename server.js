require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const { google } = require('googleapis')
const path   = require('path')
const crypto = require('crypto')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname)))

const SHEET_ID   = process.env.SPREADSHEET_ID
const JWT_SECRET = process.env.JWT_SECRET || 'po-check-secret-2024'

const USERS = [
  { name: process.env.USER1_NAME || 'ปอ',       email: process.env.USER1_EMAIL || 'po@co.com',    password: process.env.USER1_PASS || 'po1234' },
  { name: process.env.USER2_NAME || 'ผู้ใช้ 2',  email: process.env.USER2_EMAIL || 'u2@co.com',    password: process.env.USER2_PASS || 'user1234' },
  { name: process.env.USER3_NAME || 'ผู้ใช้ 3',  email: process.env.USER3_EMAIL || 'u3@co.com',    password: process.env.USER3_PASS || 'user1234' },
]

// ── JWT ───────────────────────────────────────────────────────
function signToken(p) {
  const h = b64(JSON.stringify({ alg:'HS256',typ:'JWT' }))
  const b = b64(JSON.stringify({ ...p, exp: Date.now()+7*24*3600*1000 }))
  const s = crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url')
  return `${h}.${b}.${s}`
}
function verifyToken(token) {
  try {
    const [h,b,s] = token.split('.')
    if (crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url') !== s) return null
    const p = JSON.parse(Buffer.from(b,'base64url').toString())
    return p.exp < Date.now() ? null : p
  } catch { return null }
}
function b64(s){ return Buffer.from(s).toString('base64url') }
function auth(req,res,next){
  const t = req.headers.authorization?.replace('Bearer ','')
  if(!t) return res.status(401).json({ok:false,error:'กรุณาเข้าสู่ระบบ'})
  const p = verifyToken(t)
  if(!p) return res.status(401).json({ok:false,error:'Session หมดอายุ'})
  req.user=p; next()
}

// ── Sheets helpers ────────────────────────────────────────────
function ga(){
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })
}
async function readSheet(range){
  const r = await google.sheets({version:'v4',auth:ga()}).spreadsheets.values.get({spreadsheetId:SHEET_ID,range})
  return r.data.values||[]
}
async function appendRow(sheet,row){
  await google.sheets({version:'v4',auth:ga()}).spreadsheets.values.append({
    spreadsheetId:SHEET_ID, range:`${sheet}!A1`,
    valueInputOption:'USER_ENTERED', requestBody:{values:[row]}
  })
}
async function updateRow(sheet,idx,row){
  await google.sheets({version:'v4',auth:ga()}).spreadsheets.values.update({
    spreadsheetId:SHEET_ID, range:`${sheet}!A${idx}`,
    valueInputOption:'USER_ENTERED', requestBody:{values:[row]}
  })
}
async function deleteRow(sheet,idx){
  const meta = await google.sheets({version:'v4',auth:ga()}).spreadsheets.get({spreadsheetId:SHEET_ID})
  const sh   = meta.data.sheets.find(s=>s.properties.title===sheet)
  if(!sh) throw new Error('Sheet not found')
  await google.sheets({version:'v4',auth:ga()}).spreadsheets.batchUpdate({
    spreadsheetId:SHEET_ID,
    requestBody:{requests:[{deleteDimension:{range:{sheetId:sh.properties.sheetId,dimension:'ROWS',startIndex:idx-1,endIndex:idx}}}]}
  })
}
async function log(user,action,detail){
  try{ await appendRow('LOGS',[new Date().toLocaleString('th-TH'),user.name,user.email,action,detail]) }
  catch(e){ console.error('Log err:',e.message) }
}

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req,res)=>{
  const {email,password}=req.body
  if(!email||!password) return res.status(400).json({ok:false,error:'กรุณากรอกข้อมูล'})
  const u=USERS.find(u=>u.email.toLowerCase()===email.toLowerCase()&&u.password===password)
  if(!u) return res.status(401).json({ok:false,error:'Email หรือ Password ไม่ถูกต้อง'})
  await log({name:u.name,email:u.email},'LOGIN','เข้าสู่ระบบ')
  res.json({ok:true,token:signToken({name:u.name,email:u.email}),user:{name:u.name,email:u.email}})
})
app.get('/api/auth/me', auth, (req,res)=>res.json({ok:true,user:req.user}))

// ══════════════════════════════════════════════════════════════
// PO  (cols: PONum|Client|Start|End|Emp1..30|CreatedBy|CreatedAt)
// ══════════════════════════════════════════════════════════════
app.get('/api/po', auth, async (req,res)=>{
  try{ res.json({ok:true,data:await readSheet('PO_MASTER!A2:AJ')}) }
  catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

app.get('/api/po/:poNum', auth, async (req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:AJ')
    const i=rows.findIndex(r=>r[0]===req.params.poNum)
    if(i===-1) return res.json({ok:false,error:'ไม่พบ PO'})
    const row=rows[i]
    res.json({ok:true,rowIndex:i+2,poNum:row[0],client:row[1],startDate:row[2],endDate:row[3],
      employees:row.slice(4,34).filter(e=>e&&e.trim()),createdBy:row[34],createdAt:row[35]})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

app.post('/api/po', auth, async (req,res)=>{
  try{
    const {poNum,client,startDate,endDate,employees}=req.body
    if(!poNum||!client) return res.status(400).json({ok:false,error:'กรุณากรอกเลข PO และชื่อลูกค้า'})
    const emp=[...(employees||[]).filter(e=>e.trim()).slice(0,30),...Array(30).fill('')].slice(0,30)
    await appendRow('PO_MASTER',[poNum,client,startDate||'',endDate||'',...emp,req.user.name,new Date().toLocaleString('th-TH')])
    await log(req.user,'CREATE_PO',`สร้าง PO ${poNum} (${client}) พนักงาน ${emp.filter(e=>e).length} คน`)
    res.json({ok:true})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

app.put('/api/po/:poNum', auth, async (req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:AJ')
    const i=rows.findIndex(r=>r[0]===req.params.poNum)
    if(i===-1) return res.status(404).json({ok:false,error:'ไม่พบ PO'})
    const {client,startDate,endDate,employees}=req.body
    const orig=rows[i]
    const emp=[...(employees||[]).filter(e=>e.trim()).slice(0,30),...Array(30).fill('')].slice(0,30)
    await updateRow('PO_MASTER',i+2,[req.params.poNum,client||orig[1],startDate||orig[2],endDate||orig[3],...emp,req.user.name,new Date().toLocaleString('th-TH')])
    await log(req.user,'UPDATE_PO',`แก้ไข PO ${req.params.poNum}`)
    res.json({ok:true})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

app.delete('/api/po/:poNum', auth, async (req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:AJ')
    const i=rows.findIndex(r=>r[0]===req.params.poNum)
    if(i===-1) return res.status(404).json({ok:false,error:'ไม่พบ PO'})
    await deleteRow('PO_MASTER',i+2)
    await log(req.user,'DELETE_PO',`ลบ PO ${req.params.poNum}`)
    res.json({ok:true})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

// ══════════════════════════════════════════════════════════════
// BULK UPLOAD
// Headers: PO No. | DM | Start | End | Item | Name
// Same PO across multiple rows (PO No. only in first row of group)
// ══════════════════════════════════════════════════════════════
app.post('/api/po/bulk', auth, async (req,res)=>{
  try{
    const {rows}=req.body
    if(!rows||!rows.length) return res.status(400).json({ok:false,error:'ไม่มีข้อมูล'})

    // Helper: safely convert any value to trimmed string
    const str = v => (v===null||v===undefined) ? '' : String(v).trim()

    // Walk rows; carry forward PO No./DM/dates when blank (merged-cell / carry-forward pattern)
    const grouped={}
    let lastKey='', lastDM='', lastStart='', lastEnd=''
    for(const r of rows){
      // Accept any header variant and numeric PO numbers
      const rawKey = str(r['PO No.'] ?? r['PO_No'] ?? r['PONo'] ?? r['po no.'] ?? r['poNo'] ?? '')
      const key = rawKey || lastKey
      if(!key) continue

      if(rawKey){
        lastKey   = rawKey
        lastDM    = str(r['DM']    ?? r['dm']    ?? '')
        lastStart = str(r['Start'] ?? r['start'] ?? r['START'] ?? '')
        lastEnd   = str(r['End']   ?? r['end']   ?? r['END']   ?? '')
      }

      if(!grouped[key]) grouped[key]={client:lastDM, start:lastStart, end:lastEnd, names:[]}

      // Allow DM/dates to be updated from any row in the group
      const dm = str(r['DM'] ?? r['dm'] ?? '')
      if(dm) grouped[key].client = dm

      const name = str(r['Name'] ?? r['name'] ?? r['NAME'] ?? '')
      if(name) grouped[key].names.push(name)
    }

    const existingRows=await readSheet('PO_MASTER!A2:AJ')
    let created=0,updated=0
    for(const [poNum,data] of Object.entries(grouped)){
      const emp=[...data.names.slice(0,30),...Array(30).fill('')].slice(0,30)
      const now=new Date().toLocaleString('th-TH')
      const i=existingRows.findIndex(r=>r[0]===String(poNum))
      if(i===-1){
        await appendRow('PO_MASTER',[poNum,data.client,data.start,data.end,...emp,req.user.name,now])
        created++
      } else {
        await updateRow('PO_MASTER',i+2,[poNum,data.client||existingRows[i][1],data.start||existingRows[i][2],data.end||existingRows[i][3],...emp,req.user.name,now])
        updated++
      }
    }
    await log(req.user,'BULK_UPLOAD',`Bulk upload: สร้าง ${created} แก้ไข ${updated} PO`)
    res.json({ok:true,created,updated})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

// ══════════════════════════════════════════════════════════════
// OT  (cols: PONum|EmpName|POOT|DocDate|Pay|Bill|Profit|Month|Collected|CreatedBy)
// ══════════════════════════════════════════════════════════════
app.get('/api/ot', auth, async (req,res)=>{
  try{ res.json({ok:true,data:await readSheet('OT!A2:K')}) }
  catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

app.post('/api/ot', auth, async (req,res)=>{
  try{
    const {poNum,empName,poOt,docDate,otPay,otBill}=req.body
    // poNum = mandatory, poOt = optional
    if(!poNum||!empName||!docDate||!otPay||!otBill)
      return res.status(400).json({ok:false,error:'กรุณากรอกข้อมูลที่บังคับ (*)'})
    await appendRow('OT',[poNum,empName,poOt||'',docDate,otPay,otBill,Number(otBill)-Number(otPay),docDate.slice(0,7),'ยังไม่เรียกเก็บ',req.user.name])
    await log(req.user,'CREATE_OT',`บันทึก OT พนักงาน: ${empName} PO: ${poNum}`)
    res.json({ok:true})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

// PATCH: update poOt number (edit later)
app.patch('/api/ot/:rowIdx/poot', auth, async (req,res)=>{
  try{
    const idx=parseInt(req.params.rowIdx)
    const rows=await readSheet('OT!A2:K')
    const row=rows[idx-1]
    if(!row) return res.status(404).json({ok:false,error:'ไม่พบรายการ'})
    const updated=[...row]; updated[2]=req.body.poOt||''
    await updateRow('OT',idx+1,updated.slice(0,10))
    await log(req.user,'UPDATE_OT_POOT',`แก้ไข PO_OT ของ ${row[1]} เป็น ${req.body.poOt}`)
    res.json({ok:true})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

// PATCH: toggle collected
app.patch('/api/ot/:rowIdx/collected', auth, async (req,res)=>{
  try{
    const idx=parseInt(req.params.rowIdx)
    const rows=await readSheet('OT!A2:K')
    const row=rows[idx-1]
    if(!row) return res.status(404).json({ok:false,error:'ไม่พบรายการ'})
    const newStatus=row[8]==='เรียกเก็บแล้ว'?'ยังไม่เรียกเก็บ':'เรียกเก็บแล้ว'
    const updated=[...row]; updated[8]=newStatus
    await updateRow('OT',idx+1,updated.slice(0,10))
    await log(req.user,'UPDATE_OT_STATUS',`${newStatus}: ${row[2]||'—'} (${row[1]})`)
    res.json({ok:true,status:newStatus})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

// ══════════════════════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════════════════════
app.get('/api/alerts', auth, async (req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:E')
    const today=new Date()
    res.json({ok:true,data:rows
      .map(r=>({po:r[0],client:r[1],endDate:r[3],daysLeft:Math.ceil((new Date(r[3])-today)/86400000)}))
      .filter(a=>a.endDate&&a.daysLeft>=0&&a.daysLeft<=14)
      .sort((a,b)=>a.daysLeft-b.daysLeft)})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

// ══════════════════════════════════════════════════════════════
// LOGS
// ══════════════════════════════════════════════════════════════
app.get('/api/logs', auth, async (req,res)=>{
  try{
    const rows=await readSheet('LOGS!A2:E')
    res.json({ok:true,data:[...rows].reverse().slice(0,200)})
  }catch(e){ res.status(500).json({ok:false,error:e.message}) }
})

app.get('/api/health',(req,res)=>res.json({ok:true}))
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||8080
app.listen(PORT,()=>console.log(`✅ PO System on port ${PORT}`))
