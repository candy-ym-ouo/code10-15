-- CreateEnum
CREATE TYPE "EarTrainingType" AS ENUM ('INTERVAL', 'RHYTHM');

-- CreateTable
CREATE TABLE "ear_training_questions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "EarTrainingType" NOT NULL,
    "level" SMALLINT NOT NULL,
    "seed" VARCHAR(200) NOT NULL,
    "rule_version" SMALLINT NOT NULL,
    "payload" JSONB NOT NULL,
    "canonical_answer" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ear_training_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ear_training_answers" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "EarTrainingType" NOT NULL,
    "level" SMALLINT NOT NULL,
    "rule_version" SMALLINT NOT NULL,
    "response" JSONB NOT NULL,
    "grade" JSONB NOT NULL,
    "correct" BOOLEAN NOT NULL,
    "answered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ear_training_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ear_training_questions_user_id_type_created_at_idx" ON "ear_training_questions"("user_id", "type", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ear_training_answers_question_id_key" ON "ear_training_answers"("question_id");

-- CreateIndex
CREATE INDEX "ear_training_answers_user_id_type_answered_at_idx" ON "ear_training_answers"("user_id", "type", "answered_at" DESC);

-- CreateIndex
CREATE INDEX "ear_training_answers_user_id_answered_at_idx" ON "ear_training_answers"("user_id", "answered_at" DESC);

-- AddForeignKey
ALTER TABLE "ear_training_questions" ADD CONSTRAINT "ear_training_questions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ear_training_answers" ADD CONSTRAINT "ear_training_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "ear_training_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ear_training_answers" ADD CONSTRAINT "ear_training_answers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
