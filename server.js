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

function b64(s){ return Buffer.from(s).toString('base64url') }
function signToken(p){
  const h=b64(JSON.stringify({alg:'HS256',typ:'JWT'}))
  const b=b64(JSON.stringify({...p,exp:Date.now()+7*24*3600*1000}))
  const s=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url')
  return `${h}.${b}.${s}`
}
function verifyToken(token){
  try{
    const [h,b,s]=token.split('.')
    if(crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${b}`).digest('base64url')!==s) return null
    const p=JSON.parse(Buffer.from(b,'base64url').toString())
    return p.exp<Date.now()?null:p
  }catch{return null}
}
function auth(req,res,next){
  const t=req.headers.authorization?.replace('Bearer ','')
  if(!t) return res.status(401).json({ok:false,error:'กรุณาเข้าสู่ระบบ'})
  const p=verifyToken(t)
  if(!p) return res.status(401).json({ok:false,error:'Session หมดอายุ'})
  req.user=p;next()
}

// Normalize any month/date input to YYYY-MM
function normalizeMonth(val){
  if(!val) return ''
  val=String(val).trim()
  // Format: 01-31/03/2026 or 1-31/03/2026
  const m1=val.match(/\d{1,2}-\d{1,2}\/(\d{2})\/?(\d{4})/)
  if(m1) return m1[2]+'-'+m1[1].padStart(2,'0')
  // Format: dd/mm/yyyy
  const m2=val.match(/^\d{1,2}\/(\d{2})\/(\d{4})$/)
  if(m2) return m2[2]+'-'+m2[1].padStart(2,'0')
  // Format: mm/yyyy
  const m3=val.match(/^(\d{1,2})\/(\d{4})$/)
  if(m3) return m3[2]+'-'+m3[1].padStart(2,'0')
  // Format: YYYY-MM already
  const m4=val.match(/^(\d{4})-(\d{1,2})/)
  if(m4) return m4[1]+'-'+m4[2].padStart(2,'0')
  return val
}

function ga(){
  return new google.auth.GoogleAuth({
    credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes:['https://www.googleapis.com/auth/spreadsheets']
  })
}
async function readSheet(range){
  const r=await google.sheets({version:'v4',auth:ga()}).spreadsheets.values.get({spreadsheetId:SHEET_ID,range})
  return r.data.values||[]
}
async function appendRow(sheet,row){
  await google.sheets({version:'v4',auth:ga()}).spreadsheets.values.append({
    spreadsheetId:SHEET_ID,range:`${sheet}!A1`,
    valueInputOption:'USER_ENTERED',requestBody:{values:[row]}
  })
}
async function updateRow(sheet,idx,row){
  await google.sheets({version:'v4',auth:ga()}).spreadsheets.values.update({
    spreadsheetId:SHEET_ID,range:`${sheet}!A${idx}`,
    valueInputOption:'USER_ENTERED',requestBody:{values:[row]}
  })
}
async function deleteRow(sheet,idx){
  const meta=await google.sheets({version:'v4',auth:ga()}).spreadsheets.get({spreadsheetId:SHEET_ID})
  const sh=meta.data.sheets.find(s=>s.properties.title===sheet)
  if(!sh) throw new Error('Sheet not found: '+sheet)
  await google.sheets({version:'v4',auth:ga()}).spreadsheets.batchUpdate({
    spreadsheetId:SHEET_ID,
    requestBody:{requests:[{deleteDimension:{range:{sheetId:sh.properties.sheetId,dimension:'ROWS',startIndex:idx-1,endIndex:idx}}}]}
  })
}
async function log(user,action,detail){
  try{await appendRow('LOGS',[new Date().toLocaleString('th-TH'),user.name,user.email,action,detail])}
  catch(e){console.error('Log:',e.message)}
}

// AUTH
app.post('/api/auth/login',async(req,res)=>{
  const{email,password}=req.body
  if(!email||!password) return res.status(400).json({ok:false,error:'กรุณากรอกข้อมูล'})
  const u=USERS.find(u=>u.email.toLowerCase()===email.toLowerCase()&&u.password===password)
  if(!u) return res.status(401).json({ok:false,error:'Email หรือ Password ไม่ถูกต้อง'})
  await log({name:u.name,email:u.email},'LOGIN','เข้าสู่ระบบ')
  res.json({ok:true,token:signToken({name:u.name,email:u.email}),user:{name:u.name,email:u.email}})
})
app.get('/api/auth/me',auth,(req,res)=>res.json({ok:true,user:req.user}))

// PO_MASTER
app.get('/api/po',auth,async(req,res)=>{
  try{res.json({ok:true,data:await readSheet('PO_MASTER!A2:F')})}
  catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.get('/api/po/:poNum',auth,async(req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:F')
    const i=rows.findIndex(r=>r[0]===req.params.poNum)
    if(i===-1) return res.json({ok:false,error:'ไม่พบ PO'})
    const row=rows[i]
    const empRows=await readSheet('PO_EMPLOYEES!A2:F')
    const emps=empRows.map((r,idx)=>({idx:idx+2,poNum:r[0],name:r[1],start:r[2],end:r[3],createdBy:r[4],createdAt:r[5]})).filter(e=>e.poNum===req.params.poNum)
    res.json({ok:true,rowIndex:i+2,poNum:row[0],client:row[1],startDate:row[2],endDate:row[3],createdBy:row[4],createdAt:row[5],employees:emps})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.post('/api/po',auth,async(req,res)=>{
  try{
    const{poNum,client,startDate,endDate}=req.body
    if(!poNum||!client) return res.status(400).json({ok:false,error:'กรุณากรอกเลข PO และชื่อลูกค้า'})
    await appendRow('PO_MASTER',[poNum,client,startDate||'',endDate||'',req.user.name,new Date().toLocaleString('th-TH')])
    await log(req.user,'CREATE_PO',`สร้าง PO ${poNum} (${client})`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.put('/api/po/:poNum',auth,async(req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:F')
    const i=rows.findIndex(r=>r[0]===req.params.poNum)
    if(i===-1) return res.status(404).json({ok:false,error:'ไม่พบ PO'})
    const{client,startDate,endDate}=req.body
    const orig=rows[i]
    await updateRow('PO_MASTER',i+2,[req.params.poNum,client||orig[1],startDate||orig[2],endDate||orig[3],req.user.name,new Date().toLocaleString('th-TH')])
    await log(req.user,'UPDATE_PO',`แก้ไข PO ${req.params.poNum}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.delete('/api/po/:poNum',auth,async(req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:F')
    const i=rows.findIndex(r=>r[0]===req.params.poNum)
    if(i===-1) return res.status(404).json({ok:false,error:'ไม่พบ PO'})
    await deleteRow('PO_MASTER',i+2)
    await log(req.user,'DELETE_PO',`ลบ PO ${req.params.poNum}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// PO_EMPLOYEES
app.get('/api/employees',auth,async(req,res)=>{
  try{res.json({ok:true,data:await readSheet('PO_EMPLOYEES!A2:F')})}
  catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.post('/api/employees',auth,async(req,res)=>{
  try{
    const{poNum,name,start,end}=req.body
    if(!poNum||!name) return res.status(400).json({ok:false,error:'กรุณากรอก PO และชื่อพนักงาน'})
    await appendRow('PO_EMPLOYEES',[poNum,name,start||'',end||'',req.user.name,new Date().toLocaleString('th-TH')])
    await log(req.user,'ADD_EMPLOYEE',`เพิ่มพนักงาน ${name} ใน PO ${poNum}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.delete('/api/employees/:rowIdx',auth,async(req,res)=>{
  try{
    const sheetRow=parseInt(req.params.rowIdx)
    const rows=await readSheet('PO_EMPLOYEES!A2:F')
    const row=rows[sheetRow-2]
    if(!row) return res.status(404).json({ok:false,error:'ไม่พบรายการ'})
    await deleteRow('PO_EMPLOYEES',sheetRow)
    await log(req.user,'DELETE_EMPLOYEE',`ลบพนักงาน ${row[1]} จาก PO ${row[0]}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// BULK UPLOAD
app.post('/api/po/bulk',auth,async(req,res)=>{
  try{
    const{rows}=req.body
    if(!rows||!rows.length) return res.status(400).json({ok:false,error:'ไม่มีข้อมูล'})
    const str=v=>(v===null||v===undefined)?'':String(v).trim()
    const poMap={};let lastPO='',lastDM='',lastPOStart='',lastPOEnd='';const empList=[]
    for(const r of rows){
      const rawPO=str(r['PO No.']??r['PO_No']??r['PONo']??r['po no.']??'')
      const po=rawPO||lastPO;if(!po) continue
      if(rawPO){lastPO=rawPO;lastDM=str(r['DM']??'');lastPOStart=str(r['Start']??'');lastPOEnd=str(r['End']??'')}
      if(!poMap[po]) poMap[po]={client:lastDM,start:lastPOStart,end:lastPOEnd}
      if(r['DM']&&str(r['DM'])) poMap[po].client=str(r['DM'])
      const name=str(r['Name']??r['name']??'')
      if(name) empList.push({poNum:po,name,start:str(r['Start']??''),end:str(r['End']??'')})
    }
    const existingPO=await readSheet('PO_MASTER!A2:F')
    const existingEmp=await readSheet('PO_EMPLOYEES!A2:F')
    const now=new Date().toLocaleString('th-TH')
    let poCreated=0,poUpdated=0,empAdded=0
    for(const[poNum,data] of Object.entries(poMap)){
      const i=existingPO.findIndex(r=>r[0]===String(poNum))
      if(i===-1){await appendRow('PO_MASTER',[poNum,data.client,data.start,data.end,req.user.name,now]);poCreated++}
      else{await updateRow('PO_MASTER',i+2,[poNum,data.client||existingPO[i][1],data.start||existingPO[i][2],data.end||existingPO[i][3],req.user.name,now]);poUpdated++}
    }
    for(const emp of empList){
      const dup=existingEmp.find(r=>r[0]===emp.poNum&&r[1]===emp.name&&r[2]===emp.start&&r[3]===emp.end)
      if(!dup){await appendRow('PO_EMPLOYEES',[emp.poNum,emp.name,emp.start,emp.end,req.user.name,now]);empAdded++}
    }
    await log(req.user,'BULK_UPLOAD',`Bulk: PO สร้าง ${poCreated} แก้ไข ${poUpdated} พนักงานเพิ่ม ${empAdded}`)
    res.json({ok:true,poCreated,poUpdated,empAdded})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// OT
app.get('/api/ot',auth,async(req,res)=>{
  try{res.json({ok:true,data:await readSheet('OT!A2:K')})}
  catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.post('/api/ot',auth,async(req,res)=>{
  try{
    const{poNum,empName,poOt,docDate,otPay,otBill}=req.body
    if(!poNum||!empName||!docDate||!otPay||!otBill) return res.status(400).json({ok:false,error:'กรุณากรอกข้อมูลที่บังคับ (*)'})
    await appendRow('OT',[poNum,empName,poOt||'',docDate,otPay,otBill,Number(otBill)-Number(otPay),docDate.slice(0,7),'ยังไม่เรียกเก็บ',req.user.name])
    await log(req.user,'CREATE_OT',`บันทึก OT ${empName} PO: ${poNum}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.patch('/api/ot/:rowIdx/poot',auth,async(req,res)=>{
  try{
    const idx=parseInt(req.params.rowIdx)
    const rows=await readSheet('OT!A2:K');const row=rows[idx-1]
    if(!row) return res.status(404).json({ok:false,error:'ไม่พบรายการ'})
    const updated=[...row];updated[2]=req.body.poOt||''
    await updateRow('OT',idx+1,updated.slice(0,10))
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})
app.patch('/api/ot/:rowIdx/collected',auth,async(req,res)=>{
  try{
    const idx=parseInt(req.params.rowIdx)
    const rows=await readSheet('OT!A2:K');const row=rows[idx-1]
    if(!row) return res.status(404).json({ok:false,error:'ไม่พบรายการ'})
    const newStatus=row[8]==='เรียกเก็บแล้ว'?'ยังไม่เรียกเก็บ':'เรียกเก็บแล้ว'
    const updated=[...row];updated[8]=newStatus
    await updateRow('OT',idx+1,updated.slice(0,10))
    res.json({ok:true,status:newStatus})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// ALERTS
app.get('/api/alerts',auth,async(req,res)=>{
  try{
    const rows=await readSheet('PO_MASTER!A2:D')
    const today=new Date()
    res.json({ok:true,data:rows.map(r=>({po:r[0],client:r[1],endDate:r[3],daysLeft:Math.ceil((new Date(r[3])-today)/86400000)})).filter(a=>a.endDate&&a.daysLeft>=0&&a.daysLeft<=14).sort((a,b)=>a.daysLeft-b.daysLeft)})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// EAS cols: PONum|EmpName|Month|EASNo|Status|Remark|CreatedBy|CreatedAt|Item
app.get('/api/eas',auth,async(req,res)=>{
  try{res.json({ok:true,data:await readSheet('EAS!A2:I')})}
  catch(e){res.status(500).json({ok:false,error:e.message})}
})

// GET pending/all - must be before :poNum
app.get('/api/eas/pending/all',auth,async(req,res)=>{
  try{
    const [easRows,poRows,empRows]=await Promise.all([
      readSheet('EAS!A2:I'),
      readSheet('PO_MASTER!A2:F'),
      readSheet('PO_EMPLOYEES!A2:F')
    ])
    const month=req.query.month // YYYY-MM filter
    // Build map of existing EAS records
    const easMap={}
    easRows.forEach(r=>{
      const key=r[0]+'|'+r[1]+'|'+r[2]
      if(!easMap[key]) easMap[key]={easNo:r[3],status:r[4],remark:r[5],item:r[8]||''}
    })
    // For each PO, check each employee, generate expected months
    const missing=[]
    poRows.forEach(po=>{
      const poNum=po[0];const client=po[1]
      const emps=empRows.filter(e=>e[0]===poNum)
      emps.forEach(emp=>{
        const empName=emp[1];const empStart=emp[2];const empEnd=emp[3]
        if(!empStart||!empEnd) return
        // Parse dates
        const parseDate=d=>{
          if(!d) return null
          if(d.includes('/')) return new Date(d.split('/').reverse().join('-'))
          return new Date(d)
        }
        const start=parseDate(empStart),end=parseDate(empEnd)
        if(!start||!end) return
        // Generate months
        let cur=new Date(start.getFullYear(),start.getMonth(),1)
        const endMon=new Date(end.getFullYear(),end.getMonth(),1)
        const filterMonth=month?normalizeMonth(month):''
        while(cur<=endMon){
          const ym=cur.getFullYear()+'-'+(String(cur.getMonth()+1).padStart(2,'0'))
          if(!filterMonth||ym===filterMonth){
            const key=poNum+'|'+empName+'|'+ym
            const eas=easMap[key]
            if(!eas||!eas.easNo){
              missing.push({poNum,client,empName,month:ym,empStart,empEnd,
                easNo:eas?.easNo||'',status:eas?.status||'Not Placed',remark:eas?.remark||''})
            }
          }
          cur.setMonth(cur.getMonth()+1)
        }
      })
    })
    res.json({ok:true,data:missing})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// GET placed EAS
app.get('/api/eas/placed',auth,async(req,res)=>{
  try{
    const rows=await readSheet('EAS!A2:I')
    const month=req.query.month
    const data=rows.map((r,i)=>({
      idx:i+2,poNum:r[0],empName:r[1],month:r[2],easNo:r[3],
      status:r[4],remark:r[5],createdBy:r[6],createdAt:r[7],item:r[8]||''
    })).filter(r=>r.easNo&&(!month||r.month===month))
    res.json({ok:true,data})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

app.get('/api/eas/:poNum',auth,async(req,res)=>{
  try{
    const rows=await readSheet('EAS!A2:I')
    const data=rows.map((r,i)=>({
      idx:i+2,poNum:r[0],empName:r[1],month:r[2],easNo:r[3],
      status:r[4],remark:r[5],createdBy:r[6],createdAt:r[7],item:r[8]||''
    })).filter(r=>r.poNum===req.params.poNum)
    res.json({ok:true,data})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

app.post('/api/eas',auth,async(req,res)=>{
  try{
    const{poNum,empName,month,easNo,status,remark,item}=req.body
    if(!poNum||!empName||!month) return res.status(400).json({ok:false,error:'กรุณากรอก PO ชื่อพนักงาน และเดือน'})
    if(status==='Not Placed'&&!remark) return res.status(400).json({ok:false,error:'กรุณากรอกหมายเหตุเมื่อ Not Placed'})
    const rows=await readSheet('EAS!A2:I')
    const dup=rows.findIndex(r=>r[0]===poNum&&r[1]===empName&&r[2]===month)
    if(dup!==-1) return res.status(400).json({ok:false,error:`มีข้อมูล EAS ของ ${empName} เดือน ${month} อยู่แล้ว`})
    const normalMonth=normalizeMonth(month)
    const finalStatus=easNo?'Placed':(status||'Not Placed')
    await appendRow('EAS',[poNum,empName,normalMonth,easNo||'',finalStatus,remark||'',req.user.name,new Date().toLocaleString('th-TH'),item||''])
    await log(req.user,'CREATE_EAS',`บันทึก EAS ${empName} PO:${poNum} เดือน:${month}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

app.put('/api/eas/:rowIdx',auth,async(req,res)=>{
  try{
    const sheetRow=parseInt(req.params.rowIdx)
    const rows=await readSheet('EAS!A2:I')
    const row=rows[sheetRow-2]
    if(!row) return res.status(404).json({ok:false,error:'ไม่พบรายการ (row '+sheetRow+')'})
    const{easNo,status,remark,item}=req.body
    if(status==='Not Placed'&&!remark) return res.status(400).json({ok:false,error:'กรุณากรอกหมายเหตุเมื่อ Not Placed'})
    const finalStatus=easNo?'Placed':(status||row[4])
    await updateRow('EAS',sheetRow,[row[0],row[1],row[2],easNo||row[3],finalStatus,remark||row[5],req.user.name,new Date().toLocaleString('th-TH'),item||row[8]||''])
    await log(req.user,'UPDATE_EAS',`แก้ไข EAS ${row[1]} PO:${row[0]} เดือน:${row[2]}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

app.delete('/api/eas/:rowIdx',auth,async(req,res)=>{
  try{
    const sheetRow=parseInt(req.params.rowIdx)
    const rows=await readSheet('EAS!A2:I')
    const row=rows[sheetRow-2]
    if(!row) return res.status(404).json({ok:false,error:'ไม่พบรายการ (row '+sheetRow+')'})
    await deleteRow('EAS',sheetRow)
    await log(req.user,'DELETE_EAS',`ลบ EAS ${row[1]} PO:${row[0]} เดือน:${row[2]}`)
    res.json({ok:true})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// EAS summary for dashboard
app.get('/api/eas/summary/today',auth,async(req,res)=>{
  try{
    const rows=await readSheet('EAS!A2:I')
    const today=new Date()
    const thisMonth=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')
    const placed=rows.filter(r=>r[3]&&r[2]===thisMonth).length
    const total=rows.filter(r=>r[2]===thisMonth).length
    const recent=rows.filter(r=>r[3]).slice(-5).reverse().map(r=>({poNum:r[0],empName:r[1],month:r[2],easNo:r[3],item:r[8]||''}))
    res.json({ok:true,placed,total,thisMonth,recent})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

// LOGS
app.get('/api/logs',auth,async(req,res)=>{
  try{
    const rows=await readSheet('LOGS!A2:E')
    res.json({ok:true,data:[...rows].reverse().slice(0,200)})
  }catch(e){res.status(500).json({ok:false,error:e.message})}
})

app.get('/api/health',(req,res)=>res.json({ok:true}))
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||8080
app.listen(PORT,()=>console.log(`✅ PO System on port ${PORT}`))
