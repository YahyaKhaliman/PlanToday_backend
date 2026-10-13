require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const requestLogger = require(path.join(__dirname, "middleware", "log"));

const app = express();

app.use(cors());

app.use(
    "/uploads",
    express.static(path.join(__dirname, "uploads"), {
        setHeaders: (res) => {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Cross-Origin-Resource-Policy", "cross-origin");
        },
    }),
);
app.use(
    "/image/mintaharga",
    express.static(path.join(__dirname, "image", "mintaharga"), {
        setHeaders: (res) => {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Cross-Origin-Resource-Policy", "cross-origin");
        },
    }),
);

app.use(express.json({ limit: "3mb" }));
app.use(express.urlencoded({ extended: true, limit: "3mb" }));

app.use((req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) return next();
    return requestLogger(req, res, next);
});

app.get("/api-plantoday", (req, res) => {
    res.send("PlanToday Backend Running");
});

app.use("/api", require("./routes/achRoute"));
app.use("/api", require("./routes/authRoute"));
app.use("/api", require("./routes/homeRoute"));
app.use("/api", require("./routes/kurirRoute"));
app.use("/api", require("./routes/penawaranRoute"));
app.use("/api", require("./routes/trackingPenawaranRoute"));
app.use("/api", require("./routes/trackingMapRoute"));
app.use("/api", require("./routes/trackingSpkRoute"));
app.use("/api", require("./routes/permintaanHargaRoute"));
app.use("/api", require("./routes/potensiRoute"));
app.use("/lookups", require("./routes/permintaanHargaRoute"));

app.listen(process.env.PORT, "0.0.0.0", () => {
    console.log(`Server PlanToday running in: ${process.env.PORT}`);
});
