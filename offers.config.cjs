module.exports = {
    apps: [
        {
            name: "dmarket-offers-daemon",
            script: "./dmarket.js",
            cwd: "/home/mayzer/skins/offers_parse",
            instances: 1,
            autorestart: true,
            time: true,
            out_file: "./logs/dmarket.out.log",
            error_file: "./logs/dmarket.err.log",
            env: { NODE_ENV: "production" },
        },
        {
            name: "whitemarket-offers-daemon",
            script: "./whitemarket.js",
            cwd: "/home/mayzer/skins/offers_parse",
            instances: 1,
            autorestart: true,
            time: true,
            out_file: "./logs/whitemarket.out.log",
            error_file: "./logs/whitemarket.err.log",
            env: { NODE_ENV: "production" },
        },
    ],
};
