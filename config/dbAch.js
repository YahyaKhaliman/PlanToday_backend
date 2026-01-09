const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST_ACH,
    user: process.env.DB_USER_ACH,
    password: process.env.DB_PASSWORD_ACH,
    database: process.env.DB_NAME_ACH,
    port: process.env.DB_PORT_ACH,
    waitForConnections: true,
    connectionLimit: 10,
});

module.exports = pool;
