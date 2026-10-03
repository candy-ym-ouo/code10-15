-- CreateEnum
CREATE TYPE "EarDrillKind" AS ENUM ('INTERVAL', 'RHYTHM');

-- CreateEnum
CREATE TYPE "EarDrillStatus" AS ENUM ('OPEN', 'ANSWERED');

-- CreateTable
CREATE TABLE "ear_drills" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "EarDrillKind" NOT NULL,
    "seed" VARCHAR(64) NOT NULL,
    "question_index" INTEGER NOT NULL,
    "generator_version" INTEGER NOT NULL,
    "difficulty" SMALLINT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EarDrillStatus" NOT NULL DEFAULT 'OPEN',
    "answered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ear_drills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ear_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "drill_id" UUID NOT NULL,
    "client_attempt_id" VARCHAR(64) NOT NULL,
    "answer" JSONB NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "counted" BOOLEAN NOT NULL,
    "response_ms" INTEGER,
    "rule_version" INTEGER NOT NULL,
    "score_awarded" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ear_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ear_drills_user_id_seed_question_index_key" ON "ear_drills"("user_id", "seed", "question_index");

-- CreateIndex
CREATE INDEX "ear_drills_user_id_kind_created_at_idx" ON "ear_drills"("user_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ear_attempts_drill_id_client_attempt_id_key" ON "ear_attempts"("drill_id", "client_attempt_id");

-- CreateIndex
CREATE INDEX "ear_attempts_user_id_created_at_idx" ON "ear_attempts"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "ear_drills" ADD CONSTRAINT "ear_drills_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ear_attempts" ADD CONSTRAINT "ear_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ear_attempts" ADD CONSTRAINT "ear_attempts_drill_id_fkey" FOREIGN KEY ("drill_id") REFERENCES "ear_drills"("id") ON DELETE CASCADE ON UPDATE CASCADE;
