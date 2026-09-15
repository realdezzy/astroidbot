CREATE TABLE "TelegramTopic" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "purpose" TEXT NOT NULL,
  "threadId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TelegramTopic_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramTopic_userId_purpose_key" ON "TelegramTopic"("userId", "purpose");
CREATE UNIQUE INDEX "TelegramTopic_userId_threadId_key" ON "TelegramTopic"("userId", "threadId");
ALTER TABLE "TelegramTopic" ADD CONSTRAINT "TelegramTopic_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
