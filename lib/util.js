/** Мелкие helpers, общие для сервера. */
const crypto = require('crypto');
const db = require('./db');

const now = () => db.now();

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (v) => Math.round(num(v) * 100) / 100;

function pad(n, len = 4) {
  return String(n).padStart(len, '0');
}

function genOrderNo(id) {
  const d = new Date();
  const date = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
  const rnd = pad(Math.floor(Math.random() * 10000));
  const seq = pad(id || 0, 2);
  return `PCB-${date}-${seq}${rnd.slice(0, 2)}`;
}

function genTrack() {
  return `TR${Date.now().toString().slice(-8)}${pad(Math.floor(Math.random() * 100), 2)}`;
}

function genConfirmCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

async function addEvent(orderId, actor, kind, message, tx) {
  const api = tx || db;
  await api.run(
    'INSERT INTO order_events (order_id, actor, kind, message, created_at) VALUES (?, ?, ?, ?, ?)',
    [orderId, actor, kind, message, now()]
  );
}

function boolParam(v) {
  return v ? 1 : 0;
}

module.exports = { now, num, money, genOrderNo, genTrack, genConfirmCode, addEvent, boolParam, pad };
