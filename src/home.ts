// pi-sync keeps its data outside Pi's folder, at ${PRJCT_HOME:-~/.prjct}/pi-sync, like every prjct extension.
import { homedir } from "node:os";
import { join } from "node:path";

export const prjctHome = () => process.env.PRJCT_HOME ?? join(homedir(), ".prjct");
export const syncHome = () => join(prjctHome(), "pi-sync");
