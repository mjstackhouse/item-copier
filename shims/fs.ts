// Browser stub for node:fs. The toolkit only touches the file system for zip files and
// report files, which this app never uses.
const unsupported = async (): Promise<never> => {
  throw new Error("File system is not available in the browser");
};

export const promises = { readFile: unsupported, writeFile: unsupported };
export const readFile = unsupported;
export const writeFile = unsupported;
export default { promises };
