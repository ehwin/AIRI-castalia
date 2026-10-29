"""
AIRI 密钥加密工具 — AES-256-GCM
格式与 unified-proxy/_keyref/ 完全一致:
- keys.key: 32 字节 hex 文本(64 hex 字符)
- keys.enc : JSON {"iv":hex,"tag":hex,"data":hex}
  data 解密后为 JSON,形如 {"reflect":{"api_key":"..."},"triage":{"api_key":"..."},"embedding":{"api_key":"..."}}
加密:随机 12 字节 iv, aes-256-gcm encrypt, 输出 iv/tag/data 全 hex
"""
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

__all__ = ["load_keys_enc", "save_keys_enc", "key_configured"]


def _read_key(key_path: str) -> bytes:
    with open(key_path, "r", encoding="utf-8") as f:
        return bytes.fromhex(f.read().strip())


def _ensure_key(key_path: str) -> bytes:
    """keys.key 不存在则生成 32 字节 hex;存在则复用"""
    if os.path.exists(key_path):
        try:
            key = _read_key(key_path)
            if len(key) == 32:
                return key
        except Exception:
            pass
    key = os.urandom(32)
    with open(key_path, "w", encoding="utf-8") as f:
        f.write(key.hex())
    return key


def load_keys_enc(enc_path: str, key_path: str) -> dict:
    """解密 keys.enc 返回字段字典;文件缺失/解密失败返回 {}"""
    try:
        if not os.path.exists(enc_path) or not os.path.exists(key_path):
            return {}
        key = _read_key(key_path)
        with open(enc_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        ct = bytes.fromhex(payload["data"])
        nonce = bytes.fromhex(payload["iv"])
        tag = bytes.fromhex(payload["tag"])
        pt = AESGCM(key).decrypt(nonce, ct + tag, None)
        data = json.loads(pt.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_keys_enc(updates: dict, enc_path: str, key_path: str):
    """合并现有字段并加密写回 keys.enc;keys.key 不存在则生成 32 字节 hex"""
    key = _ensure_key(key_path)
    existing = load_keys_enc(enc_path, key_path)
    if not isinstance(existing, dict):
        existing = {}
    for channel, api_key in updates.items():
        if isinstance(api_key, dict):
            api_key = api_key.get("api_key")
        if api_key is None:
            continue
        entry = existing.get(channel)
        entry = dict(entry) if isinstance(entry, dict) else {}
        entry["api_key"] = str(api_key).strip()
        existing[channel] = entry
    nonce = os.urandom(12)
    aed = AESGCM(key)
    ct_tag = aed.encrypt(nonce, json.dumps(existing, ensure_ascii=False).encode("utf-8"), None)
    ct, tag = ct_tag[:-16], ct_tag[-16:]
    payload = {
        "iv": nonce.hex(),
        "tag": tag.hex(),
        "data": ct.hex(),
    }
    with open(enc_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


def key_configured(enc_path: str, key_path: str, channel: str) -> bool:
    """指定通道是否已配置非空 api_key"""
    try:
        keys = load_keys_enc(enc_path, key_path)
        entry = keys.get(channel) if isinstance(keys, dict) else {}
        if not isinstance(entry, dict):
            return False
        return bool((entry.get("api_key") or "").strip())
    except Exception:
        return False
