export default {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
      },
    ],
  },
  moduleNameMapper: {
    "^@svta/cml-iso-bmff/dist/index.js$":
      "<rootDir>/node_modules/@svta/cml-iso-bmff/dist/index.js",
    "^uint8-varint/dist/src/index.js$":
      "<rootDir>/node_modules/uint8-varint/dist/src/index.js",
  },
};
