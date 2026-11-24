import bodyReader from "body-reader";

export const readLegacy = (req) => bodyReader(req);
