const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');

module.exports = {
    mode: process.env.NODE_ENV === 'development' ? 'development' : 'production',
    devtool: 'cheap-source-map',
    entry: {
        background: path.resolve(__dirname, "src", "background.ts"),
        app: path.resolve(__dirname, "src", "app.tsx"),
        content: path.resolve(__dirname, "src", "content.ts"),
        interceptor: path.resolve(__dirname, "src", "interceptor.ts"),
        contentPaV3: path.resolve(__dirname, "src", "contentPaV3.ts"),
        interceptorPaV3: path.resolve(__dirname, "src", "interceptorPaV3.ts"),
    },
    output: {
        path: path.join(__dirname, "dist"),
        filename: "[name].js",
        // Monaco's json/monaco.contribution sets up its mode via a dynamic import(), which
        // webpack otherwise emits as a separate async chunk. Content scripts can't load
        // async chunks (the injected <script> executes in the page's MAIN world, invisible
        // to the ISOLATED-world bundle), so the JSON tokenizer never attached and the editor
        // rendered plain black text. Inlining async chunks into the entry bundles fixes it;
        // worker entrypoints are separate entries and are unaffected.
        asyncChunks: false,
    },
    resolve: {
        extensions: [".ts", ".js", ".tsx", ".json"],
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                loader: "ts-loader",
                exclude: /node_modules/,
            },
            {
                test: /\.css$/i,
                use: ["style-loader", "css-loader"],
            },
        ],
    },
    plugins: [
        new CopyPlugin({
            patterns: [{ from: ".", to: ".", context: "public" }]
        }),
        new MonacoWebpackPlugin({
            languages: ['json'],
        })
    ],
};