// middleware/log.js
module.exports = function requestLogger(req, res, next) {
    console.log(`${req.method} ${req.originalUrl}`);
    next();
};
