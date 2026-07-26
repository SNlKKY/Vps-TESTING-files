from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from datetime import datetime

BOT_TOKEN = "8521376955:AAF5bhaVX0SavTZX1312K8pklZ74NHx5mTE"

# Bot start time
START_TIME = datetime.now()

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("✅ Bot Online!")

async def uptime(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uptime = datetime.now() - START_TIME

    days = uptime.days
    hours, rem = divmod(uptime.seconds, 3600)
    minutes, seconds = divmod(rem, 60)

    await update.message.reply_text(
        f"🟢 Bot Uptime\n\n"
        f"📅 Days: {days}\n"
        f"⏰ Hours: {hours}\n"
        f"🕐 Minutes: {minutes}\n"
        f"⌛ Seconds: {seconds}"
    )

app = Application.builder().token(BOT_TOKEN).build()

app.add_handler(CommandHandler("start", start))
app.add_handler(CommandHandler("uptime", uptime))

print("Bot Started...")
app.run_polling()
