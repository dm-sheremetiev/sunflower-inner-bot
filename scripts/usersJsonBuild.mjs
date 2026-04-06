import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const backupPath = path.join(root, ".users.json.build-backup");

function getTargetPath() {
  const raw = process.env.USERS_JSON_PATH?.trim();
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  }
  return path.join(root, "users.json");
}

/** Шукаємо дані користувачів: спочатку корінь репо, потім USERS_JSON_PATH, потім dist (після clean dist). */
function findExistingUsersFile() {
  const rootUsers = path.join(root, "users.json");
  const primary = getTargetPath();
  const inDist = path.join(root, "dist", "users.json");

  if (fs.existsSync(rootUsers)) {
    return rootUsers;
  }
  if (primary !== rootUsers && fs.existsSync(primary)) {
    return primary;
  }
  if (fs.existsSync(inDist)) {
    return inDist;
  }
  return null;
}

function pre() {
  try {
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  } catch {
    /* ignore */
  }
  const existing = findExistingUsersFile();
  if (existing) {
    fs.copyFileSync(existing, backupPath);
    console.log("[build] users.json: збережено резервну копію з", existing);
  }
}

function post() {
  const target = getTargetPath();
  if (fs.existsSync(backupPath)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backupPath, target);
    fs.unlinkSync(backupPath);
    console.log("[build] users.json: відновлено з резервної копії →", target);
    return;
  }
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}\n", "utf8");
    console.log("[build] users.json: створено порожній файл →", target);
  }
}

const phase = process.argv[2];
if (phase === "pre") {
  pre();
} else if (phase === "post") {
  post();
} else {
  console.error("Usage: node scripts/usersJsonBuild.mjs pre|post");
  process.exit(1);
}
