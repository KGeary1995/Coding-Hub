const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
try {
 if (process.platform !== 'win32') throw new Error('Authenticode verification requires native Windows.');
 const args = process.argv.slice(2); if (args.length !== 2 || args[0] !== '--directory') throw new Error('Use --directory <verified build folder>.');
 const root = path.resolve(args[1]); const expected = process.env.WINDOWS_PUBLISHER_NAME; if (!expected) throw new Error('Set the public WINDOWS_PUBLISHER_NAME before verification.');
 const artifacts = fs.readdirSync(root).filter((name) => /-(Setup|Portable)\.exe$/.test(name)); if (artifacts.length !== 2) throw new Error('Expected one installer and one portable executable.');
 const appFiles=[]; for(const name of fs.readdirSync(root)){const candidate=path.join(root,name,'AI Coding Hub.exe');if(fs.existsSync(candidate))appFiles.push(candidate);}
 if(appFiles.length!==1)throw new Error('Expected one unpacked application executable.');
 const files=[...artifacts.map((name)=>path.join(root,name)),...appFiles]; const temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-signature-'));
 try {
  const script=path.join(temp,'verify.ps1');fs.writeFileSync(script,'param([string]$Artifact)\n$ErrorActionPreference="Stop"\n$s=Get-AuthenticodeSignature -LiteralPath $Artifact\nif($s.Status -ne "Valid" -or $null -eq $s.SignerCertificate){ throw "Authenticode validation failed" }\n[pscustomobject]@{status=[string]$s.Status;publisher=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false);thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress\n');
  const reports=files.map((file)=>{const result=spawnSync(path.win32.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Artifact',file],{encoding:'utf8',windowsHide:true,timeout:30000});if(result.error||result.status!==0)throw new Error('Authenticode signature validation failed for '+path.basename(file));const report=JSON.parse(result.stdout.trim());if(report.status!=='Valid'||report.publisher.toLowerCase()!==expected.toLowerCase())throw new Error('Signer does not match the expected publisher for '+path.basename(file));return {...report,file:path.relative(root,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};});
  fs.writeFileSync(path.join(root,'windows-signature-report.json'),JSON.stringify({checkedAt:new Date().toISOString(),publisher:expected,artifacts:reports},null,2));console.log('Verified Authenticode trust, expected publisher, and hashes for installer, portable, and application executables.');
 } finally {fs.rmSync(temp,{recursive:true,force:true});}
} catch(error){console.error(error.message);process.exitCode=1;}
