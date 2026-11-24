import bodyReader from "body-reader";

export const read = (req) => bodyReader(req);
