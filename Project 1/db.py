# db.py
import os
import motor.motor_asyncio

# Use local Mongo unless overridden by env var
MONGO_URL = os.getenv("MONGO_URL", "mongodb://localhost:27017")

client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
db = client["diagram_app"]            # database name
diagrams = db["diagrams"]             # collection name
users = db["users"]                   # collection name (login/signup)