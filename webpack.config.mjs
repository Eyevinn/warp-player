import path from "path";
import { fileURLToPath } from "url";
import HtmlWebpackPlugin from "html-webpack-plugin";
import CopyWebpackPlugin from "copy-webpack-plugin";
import webpack from "webpack";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf-8"),
);

export default (env, argv) => {
  const isProduction = argv.mode === "production";

  return {
    mode: isProduction ? "production" : "development",
    entry: "./src/browser.ts",
    devtool: isProduction ? "source-map" : "inline-source-map",
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
        {
          test: /\.(png|jpg|gif|svg)$/i,
          type: "asset/resource",
        },
      ],
    },
    resolve: {
      extensions: [".tsx", ".ts", ".js"],
      extensionAlias: {
        ".js": [".js", ".ts"],
      },
    },
    output: {
      filename: isProduction ? "[name].[contenthash].js" : "bundle.js",
      path: path.resolve(__dirname, "dist"),
      clean: true, // Clean the output directory before emit
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./src/index.html",
        title: "WARP Player",
        minify: isProduction
          ? {
              collapseWhitespace: true,
              removeComments: true,
              removeRedundantAttributes: true,
              removeScriptTypeAttributes: true,
              removeStyleLinkTypeAttributes: true,
              useShortDoctype: true,
            }
          : false,
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: "src/assets/images/eyevinn-technology-logo-white-400px.png",
            to: "eyevinn-technology-logo-white-400px.png",
          },
          { from: "src/config.json", to: "config.json" },
        ],
      }),
      new webpack.DefinePlugin({
        __APP_VERSION__: JSON.stringify(packageJson.version),
      }),
    ],
    devServer: {
      static: {
        directory: path.join(__dirname, "dist"),
      },
      compress: true,
      port: 8080,
      server: "http", // Changed from https to http
      client: {
        overlay: true,
      },
    },
    optimization: {
      splitChunks: isProduction
        ? {
            chunks: "all",
          }
        : false,
      minimize: isProduction,
    },
  };
};
