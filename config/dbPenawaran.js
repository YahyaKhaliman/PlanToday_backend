const mysql = require("mysql2/promise");
require("dotenv").config();

const pool = mysql.createPool({
    host: process.env.DB_HOST_PENAWARAN || process.env.DB_HOST_MAIN,
    user: process.env.DB_USER_PENAWARAN || process.env.DB_USER_MAIN,
    password: process.env.DB_PASSWORD_PENAWARAN || process.env.DB_PASSWORD_MAIN,
    database: process.env.DB_NAME_PENAWARAN || process.env.DB_NAME_MAIN,
    port: process.env.DB_PORT_PENAWARAN || process.env.DB_PORT_MAIN,
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

module.exports = pool;
