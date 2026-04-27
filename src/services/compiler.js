const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

function parseTactError(output) {
    const lines = output.split('\n');
    const errorMarkers = [];
    for (let i = 0; i < lines.length; i++) {
        // Match standard Tact error format: file.tact:line:col: message
        const match = lines[i].match(/(.*?\.tact):(\d+):(\d+): (.*)/);
        if (match) {
            errorMarkers.push(`Line ${match[2]}, Col ${match[3]}: ${match[4]}`);
        }
    }
    return errorMarkers.length > 0 ? `Detailed Errors:\n${errorMarkers.join('\n')}` : output.slice(0, 1000);
}

function extractContractName(code) {
    const match = code.match(/contract\s+([a-zA-Z0-9]+)/);
    return match ? match[1] : 'Generated';
}

async function compileSilent(code, fileName, sessionPath) {
    const tempFile = path.join(sessionPath, fileName);
    fs.writeFileSync(tempFile, code);
    
    const tempConfigPath = path.join(sessionPath, `temp_verify_${fileName}.json`);
    const projectName = `Verify_${fileName.replace('.tact', '').replace(/[^a-zA-Z0-9]/g, '_')}`;
    const buildVerifyDir = path.join(sessionPath, 'build_verify');
    
    if (!fs.existsSync(buildVerifyDir)) fs.mkdirSync(buildVerifyDir, { recursive: true });

    const tempConfig = {
        projects: [{
            name: projectName,
            path: `./${fileName}`,
            output: './build_verify',
            options: { debug: true, external: true }
        }]
    };
    
    fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));
    logger.debug(`Starting silent compilation for verification: ${projectName}`, 'VERIFY');
    try {
        const cmd = `npx tact --config "${path.basename(tempConfigPath)}" 2>&1`;
        logger.trace(`Exec: ${cmd}`, 'VERIFY');
        const out = execSync(cmd, { cwd: sessionPath, stdio: 'pipe', timeout: 60000 });
        logger.debug(`Silent compilation successful`, 'VERIFY');
        
        const abiPath = path.join(buildVerifyDir, `${projectName}.abi`);
        let abi = null;
        if (fs.existsSync(abiPath)) {
            abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            logger.trace(`ABI loaded for ${projectName}`, 'VERIFY');
        }
        return { success: true, abi };
    } catch (e) {
        const err = e.stdout ? e.stdout.toString() : e.message;
        logger.warn(`Silent compilation failed`, 'VERIFY', err);
        return { success: false, error: parseTactError(err) };
    } finally {
        try {
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (fs.existsSync(buildVerifyDir)) fs.rmSync(buildVerifyDir, { recursive: true, force: true });
            logger.trace(`Cleanup verification artifacts for ${projectName}`, 'VERIFY');
        } catch (cleanupErr) {
            logger.error('Cleanup failed', 'VERIFY', cleanupErr);
        }
    }
}

let compileQueue = Promise.resolve();
function queueCompileTask(task) {
  const run = compileQueue.then(task, task);
  compileQueue = run.catch((e) => {
    logger.error('Queue task failed', '', e);
  });
  return run;
}

module.exports = {
    parseTactError,
    extractContractName,
    compileSilent,
    queueCompileTask
};
