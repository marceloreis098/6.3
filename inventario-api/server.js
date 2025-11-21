require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const fs = require('fs');
const path = require('path');
// Removemos node-fetch nativo pois versões recentes do Node já possuem fetch, 
// mas garantimos compatibilidade se necessário.
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();

// Enable CORS for all origins
app.use(cors());

app.use(express.json({ limit: '50mb' })); // Increased limit for large CSVs and photos
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.API_PORT || 3001;
const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10');

// Database credentials
const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_DATABASE = process.env.DB_DATABASE;

// OLLAMA CONFIGURATION
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const LOCAL_MODEL = process.env.LOCAL_MODEL || 'llama3.2'; // Modelo Llama 3.2 (3B) - Mais inteligente e robusto

// Backup directory
const BACKUP_DIR = './backups';
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR);
}

const db = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true
});

// --- AUTO-REPAIR SCHEMA FUNCTION ---
const ensureCriticalSchema = async (connection) => {
    console.log("Running critical schema check...");
    
    const checkAndAddColumn = async (tableName, columnName, columnDef) => {
        try {
            const [tableExists] = await connection.query(`SHOW TABLES LIKE '${tableName}'`);
            if (tableExists.length === 0) return;

            const [columns] = await connection.query(`SHOW COLUMNS FROM ${tableName}`);
            const columnNames = columns.map(c => c.Field);

            if (!columnNames.includes(columnName)) {
                console.log(`Auto-repair: Adding '${columnName}' to ${tableName}`);
                await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
            }
        } catch (err) {
            console.error(`Error checking column ${columnName} in ${tableName}:`, err.message);
        }
    };

    // 1. Add missing columns to tables
    await checkAndAddColumn('licenses', 'empresa', 'VARCHAR(255) NULL');
    await checkAndAddColumn('licenses', 'observacoes', 'TEXT');
    await checkAndAddColumn('licenses', 'approval_status', "VARCHAR(50) DEFAULT 'approved'");
    await checkAndAddColumn('licenses', 'rejection_reason', 'TEXT');
    await checkAndAddColumn('licenses', 'created_by_id', 'INT NULL');
    
    await checkAndAddColumn('equipment', 'observacoes', 'TEXT');
    await checkAndAddColumn('equipment', 'approval_status', "VARCHAR(50) DEFAULT 'approved'");
    await checkAndAddColumn('equipment', 'rejection_reason', 'TEXT');
    await checkAndAddColumn('equipment', 'created_by_id', 'INT NULL');
    await checkAndAddColumn('equipment', 'emailColaborador', 'VARCHAR(255)');
    
    // Absolute Report Fields
    await checkAndAddColumn('equipment', 'brand', 'VARCHAR(100)');
    await checkAndAddColumn('equipment', 'model', 'VARCHAR(100)');
    await checkAndAddColumn('equipment', 'identificador', 'VARCHAR(255)');
    await checkAndAddColumn('equipment', 'nomeSO', 'VARCHAR(255)');
    await checkAndAddColumn('equipment', 'memoriaFisicaTotal', 'VARCHAR(100)');
    await checkAndAddColumn('equipment', 'grupoPoliticas', 'VARCHAR(100)');
    await checkAndAddColumn('equipment', 'pais', 'VARCHAR(100)');
    await checkAndAddColumn('equipment', 'cidade', 'VARCHAR(100)');
    await checkAndAddColumn('equipment', 'estadoProvincia', 'VARCHAR(100)');
    await checkAndAddColumn('equipment', 'condicaoTermo', "ENUM('Assinado - Entrega', 'Assinado - Devolução', 'Pendente', 'N/A') DEFAULT 'N/A'");

    await checkAndAddColumn('users', 'twoFASecret', 'VARCHAR(255) NULL');
    await checkAndAddColumn('users', 'is2FAEnabled', 'BOOLEAN DEFAULT FALSE');
    await checkAndAddColumn('users', 'avatarUrl', 'MEDIUMTEXT');
    
    // 2. CRITICAL FIX FOR EQUIPMENT HISTORY
    // Ensure the correct snake_case column exists
    await checkAndAddColumn('equipment_history', 'equipment_id', 'INT');

    // Fix 1: Make legacy 'equipmentId' (camelCase) nullable if it exists to prevent "doesn't have a default value" error
    try {
        const [camelCols] = await connection.query("SHOW COLUMNS FROM equipment_history LIKE 'equipmentId'");
        if (camelCols.length > 0) {
            console.log("Auto-repair: Making legacy column 'equipmentId' NULLABLE to fix Insert error.");
            await connection.query("ALTER TABLE equipment_history MODIFY COLUMN equipmentId INT NULL");
        }
    } catch (err) {
        console.error("Auto-repair warning for equipmentId:", err.message);
    }

    // Fix 2: Ensure 'timestamp' has a default value of CURRENT_TIMESTAMP to prevent "doesn't have a default value" error
    try {
        const [tsCols] = await connection.query("SHOW COLUMNS FROM equipment_history LIKE 'timestamp'");
        if (tsCols.length > 0) {
             console.log("Auto-repair: Ensuring 'timestamp' has DEFAULT CURRENT_TIMESTAMP.");
             await connection.query("ALTER TABLE equipment_history MODIFY COLUMN timestamp DATETIME DEFAULT CURRENT_TIMESTAMP");
        }
    } catch (err) {
        console.error("Auto-repair warning for timestamp:", err.message);
    }

    // Fix 3: Ensure 'audit_log' timestamp also has default value
    try {
        const [tsColsAudit] = await connection.query("SHOW COLUMNS FROM audit_log LIKE 'timestamp'");
        if (tsColsAudit.length > 0) {
             console.log("Auto-repair: Ensuring audit_log 'timestamp' has DEFAULT CURRENT_TIMESTAMP.");
             await connection.query("ALTER TABLE audit_log MODIFY COLUMN timestamp DATETIME DEFAULT CURRENT_TIMESTAMP");
        }
    } catch (err) {
        console.error("Auto-repair warning for audit_log timestamp:", err.message);
    }

    console.log("Critical schema check complete.");
};

const runMigrations = async () => {
    console.log("Checking database migrations...");
    let connection;
    try {
        connection = await db.promise().getConnection();
        
        await connection.query(`
            CREATE TABLE IF NOT EXISTS migrations (
                id INT PRIMARY KEY
            );
        `);

        const [executedRows] = await connection.query('SELECT id FROM migrations');
        const executedMigrationIds = new Set(executedRows.map((r) => r.id));

        const migrations = [
            {
                id: 1, sql: `
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(255) NOT NULL UNIQUE,
                    realName VARCHAR(255) NOT NULL,
                    email VARCHAR(255) NOT NULL UNIQUE,
                    password VARCHAR(255) NOT NULL,
                    role ENUM('Admin', 'User Manager', 'User') NOT NULL,
                    lastLogin DATETIME,
                    is2FAEnabled BOOLEAN DEFAULT FALSE,
                    twoFASecret VARCHAR(255),
                    ssoProvider VARCHAR(50) NULL,
                    avatarUrl MEDIUMTEXT
                );`
            },
            {
                id: 2, sql: `
                CREATE TABLE IF NOT EXISTS equipment (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    equipamento VARCHAR(255) NOT NULL,
                    garantia VARCHAR(255),
                    patrimonio VARCHAR(255) UNIQUE,
                    serial VARCHAR(255) UNIQUE,
                    usuarioAtual VARCHAR(255),
                    usuarioAnterior VARCHAR(255),
                    local VARCHAR(255),
                    setor VARCHAR(255),
                    dataEntregaUsuario VARCHAR(255),
                    status VARCHAR(255),
                    dataDevolucao VARCHAR(255),
                    tipo VARCHAR(255),
                    notaCompra VARCHAR(255),
                    notaPlKm VARCHAR(255),
                    termoResponsabilidade VARCHAR(255),
                    foto TEXT,
                    qrCode TEXT,
                    observacoes TEXT,
                    approval_status VARCHAR(50) DEFAULT 'approved',
                    rejection_reason TEXT
                );`
            },
            {
                id: 3, sql: `
                CREATE TABLE IF NOT EXISTS licenses (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    produto VARCHAR(255) NOT NULL,
                    tipoLicenca VARCHAR(255),
                    chaveSerial VARCHAR(255) NOT NULL,
                    dataExpiracao VARCHAR(255),
                    usuario VARCHAR(255) NOT NULL,
                    cargo VARCHAR(255),
                    setor VARCHAR(255),
                    gestor VARCHAR(255),
                    centroCusto VARCHAR(255),
                    contaRazao VARCHAR(255),
                    nomeComputador VARCHAR(255),
                    numeroChamado VARCHAR(255),
                    observacoes TEXT,
                    approval_status VARCHAR(50) DEFAULT 'approved',
                    rejection_reason TEXT
                );`
            },
            {
                id: 4, sql: `
                CREATE TABLE IF NOT EXISTS equipment_history (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    equipment_id INT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    changedBy VARCHAR(255),
                    changeType VARCHAR(255),
                    from_value TEXT,
                    to_value TEXT,
                    FOREIGN KEY (equipment_id) REFERENCES equipment(id) ON DELETE CASCADE
                );`
            },
            {
                id: 5, sql: `
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    username VARCHAR(255),
                    action_type VARCHAR(255),
                    target_type VARCHAR(255),
                    target_id VARCHAR(255),
                    details TEXT
                );`
            },
            {
                id: 6, sql: `
                CREATE TABLE IF NOT EXISTS app_config (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    config_key VARCHAR(255) NOT NULL UNIQUE,
                    config_value TEXT
                );`
            },
            {
                id: 7, sql: `INSERT IGNORE INTO users (username, realName, email, password, role) VALUES ('admin', 'Admin', 'admin@example.com', '${bcrypt.hashSync("marceloadmin", SALT_ROUNDS)}', 'Admin');`
            },
            {
                id: 8, sql: `
                INSERT IGNORE INTO app_config (config_key, config_value) VALUES ('companyName', 'MRR INFORMATICA');
                INSERT IGNORE INTO app_config (config_key, config_value) VALUES ('isSsoEnabled', 'false');
                `
            },
            { id: 9, sql: "ALTER TABLE equipment ADD COLUMN emailColaborador VARCHAR(255);" },
            {
                id: 10, sql: `
                INSERT IGNORE INTO app_config (config_key, config_value) VALUES ('termo_entrega_template', NULL);
                INSERT IGNORE INTO app_config (config_key, config_value) VALUES ('termo_devolucao_template', NULL);
            `},
            { id: 11, sql: "ALTER TABLE users ADD COLUMN avatarUrl MEDIUMTEXT;" },
            { id: 12, sql: "ALTER TABLE users MODIFY COLUMN avatarUrl MEDIUMTEXT;" },
            { id: 13, sql: "ALTER TABLE licenses ADD COLUMN created_by_id INT NULL;"}, 
            { id: 14, sql: "ALTER TABLE equipment ADD COLUMN created_by_id INT NULL;"}, 
            {
                id: 15, sql: `INSERT IGNORE INTO app_config (config_key, config_value) VALUES ('is2faEnabled', 'false');`
            }
        ];

        await ensureCriticalSchema(connection);

        for (const migration of migrations) {
            if (!executedMigrationIds.has(migration.id)) {
                console.log(`Running migration ${migration.id}...`);
                try {
                    await connection.query(migration.sql);
                    await connection.query('INSERT INTO migrations (id) VALUES (?)', [migration.id]);
                    console.log(`Migration ${migration.id} completed.`);
                } catch (err) {
                    console.error(`Migration ${migration.id} failed:`, err.message);
                }
            }
        }
        console.log("Migrations check complete.");
    } catch (error) {
        console.error("Migration failed:", error);
    } finally {
        if (connection) connection.release();
    }
};

// --- ROUTES ---

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [users] = await db.promise().query('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) {
            return res.status(401).json({ message: 'Usuário não encontrado' });
        }
        const user = users[0];
        
        if (user.ssoProvider) {
             return res.status(401).json({ message: 'Por favor, use o login via SSO.' });
        }

        const isPasswordValid = bcrypt.compareSync(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Senha incorreta' });
        }

        // Check global settings to see if 2FA setup is required
        const [settingsRows] = await db.promise().query('SELECT config_value FROM app_config WHERE config_key = "require2fa"');
        const require2FA = settingsRows.length > 0 && settingsRows[0].config_value === 'true';

        await db.promise().query('UPDATE users SET lastLogin = NOW() WHERE id = ?', [user.id]);
        // Explicit timestamp NOW() for audit_log to fix potential "default value" errors
        await db.promise().query('INSERT INTO audit_log (username, action_type, target_type, target_id, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())', [username, 'LOGIN', 'USER', user.id, 'User logged in']);
        
        const { password: _, twoFASecret: __, ...userWithoutSensitiveData } = user;
        
        // Inform frontend if 2FA setup is required
        if (require2FA && !user.is2FAEnabled) {
            userWithoutSensitiveData.requires2FASetup = true;
        }

        res.json(userWithoutSensitiveData);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ------------------------------------------------------------------
// EQUIPMENT ROUTES
// ------------------------------------------------------------------

app.get('/api/equipment', async (req, res) => {
    try {
        const [rows] = await db.promise().query('SELECT * FROM equipment WHERE approval_status = "approved" ORDER BY id DESC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post('/api/equipment', async (req, res) => {
    const { equipment, username } = req.body;
    const columns = Object.keys(equipment).join(', ');
    const placeholders = Object.keys(equipment).map(() => '?').join(', ');
    const values = Object.values(equipment);
    
    try {
        const [result] = await db.promise().query(`INSERT INTO equipment (${columns}) VALUES (${placeholders})`, values);
        const newId = result.insertId;
        
        await db.promise().query('INSERT INTO equipment_history (equipment_id, timestamp, changedBy, changeType, to_value) VALUES (?, NOW(), ?, ?, ?)', 
            [newId, username, 'CREATE', JSON.stringify(equipment)]);
        await db.promise().query('INSERT INTO audit_log (username, action_type, target_type, target_id, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())', 
            [username, 'CREATE', 'EQUIPMENT', newId, `Created equipment: ${equipment.equipamento}`]);
            
        res.json({ id: newId, ...equipment });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.put('/api/equipment/:id', async (req, res) => {
    const { id } = req.params;
    const { equipment, username } = req.body;
    
    try {
        // Get old values for history
        const [oldData] = await db.promise().query('SELECT * FROM equipment WHERE id = ?', [id]);
        
        const updates = Object.keys(equipment).map(key => `${key} = ?`).join(', ');
        const values = [...Object.values(equipment), id];
        
        await db.promise().query(`UPDATE equipment SET ${updates} WHERE id = ?`, values);
        
        // Log history
        if (oldData.length > 0) {
             await db.promise().query('INSERT INTO equipment_history (equipment_id, timestamp, changedBy, changeType, from_value, to_value) VALUES (?, NOW(), ?, ?, ?, ?)', 
            [id, username, 'UPDATE', JSON.stringify(oldData[0]), JSON.stringify(equipment)]);
        }
        
        await db.promise().query('INSERT INTO audit_log (username, action_type, target_type, target_id, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())', 
            [username, 'UPDATE', 'EQUIPMENT', id, `Updated equipment: ${equipment.equipamento}`]);
            
        res.json({ id, ...equipment });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.delete('/api/equipment/:id', async (req, res) => {
    const { id } = req.params;
    const { username } = req.body; // Username needed for audit log
    
    try {
        await db.promise().query('DELETE FROM equipment WHERE id = ?', [id]);
        await db.promise().query('INSERT INTO audit_log (username, action_type, target_type, target_id, details, timestamp) VALUES (?, ?, ?, ?, ?, NOW())', 
            [username, 'DELETE', 'EQUIPMENT', id, 'Deleted equipment']);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get('/api/equipment/:id/history', async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.promise().query('SELECT * FROM equipment_history WHERE equipment_id = ? ORDER BY timestamp DESC', [id]);
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// PERIODIC UPDATE ROUTE
app.post('/api/equipment/periodic-update', async (req, res) => {
    const { equipmentList, username } = req.body;
    if (!Array.isArray(equipmentList)) {
        return res.status(400).json({ message: 'Lista de equipamentos inválida.' });
    }

    const connection = await db.promise().getConnection();
    try {
        await connection.beginTransaction();

        for (const item of equipmentList) {
            if (!item.serial) continue;

            // Check if equipment exists by serial
            const [existing] = await connection.query('SELECT * FROM equipment WHERE serial = ?', [item.serial]);
            
            if (existing.length > 0) {
                // Update existing
                const current = existing[0];
                let hasChanges = false;
                const updates = [];
                const values = [];
                const historyEntries = [];

                for (const key in item) {
                    // Skip special fields or fields that match existing data
                    if (key !== 'id' && item[key] !== undefined && item[key] !== null && String(item[key]) !== String(current[key])) {
                        updates.push(`${key} = ?`);
                        values.push(item[key]);
                        hasChanges = true;
                        
                        // Prepare history entry
                        historyEntries.push({
                            equipment_id: current.id,
                            changedBy: username,
                            changeType: 'UPDATE (AUTO)',
                            from_value: String(current[key] || ''),
                            to_value: String(item[key])
                        });
                    }
                }

                if (hasChanges) {
                    values.push(current.id);
                    await connection.query(`UPDATE equipment SET ${updates.join(', ')} WHERE id = ?`, values);
                    
                    // Insert history
                    for (const entry of historyEntries) {
                        // Use equipment_id (snake_case) and explicitly set timestamp with NOW() to avoid "Field doesn't have a default value" error
                        await connection.query(
                            'INSERT INTO equipment_history (equipment_id, timestamp, changedBy, changeType, from_value, to_value) VALUES (?, NOW(), ?, ?, ?, ?)',
                            [entry.equipment_id, entry.changedBy, entry.changeType, entry.from_value, entry.to_value]
                        );
                    }
                }
            } else {
                // Insert new
                const columns = Object.keys(item).filter(k => item[k] !== undefined);
                if (columns.length === 0) continue;
                
                const placeholders = columns.map(() => '?').join(', ');
                const values = columns.map(k => item[k]);
                
                columns.push('approval_status');
                values.push('approved');
                const placeholdersFinal = placeholders + ', ?';

                const [result] = await connection.query(
                    `INSERT INTO equipment (${columns.join(', ')}) VALUES (${placeholdersFinal})`,
                    values
                );
                
                const newId = result.insertId;
                // History log for creation
                // Explicit timestamp NOW()
                await connection.query(
                    'INSERT INTO equipment_history (equipment_id, timestamp, changedBy, changeType, from_value, to_value) VALUES (?, NOW(), ?, ?, ?, ?)',
                    [newId, username, 'CREATE (IMPORT)', null, 'Importado via Atualização Periódica