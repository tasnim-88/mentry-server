const fs = require('fs');
const key = fs.readFileSync('./digital-lesson-authenti-5320e-firebase-adminsdk-fbsvc-fbcd6128cd.json', 'utf8')
const base64 = Buffer.from(key).toString('base64')
// console.log(base64)