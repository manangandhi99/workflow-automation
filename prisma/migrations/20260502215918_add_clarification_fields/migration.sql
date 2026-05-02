-- AlterEnum
ALTER TYPE "WorkflowStatus" ADD VALUE 'NEEDS_CLARIFICATION';

-- AlterTable
ALTER TABLE "workflows" ADD COLUMN     "clarificationAnswer" TEXT,
ADD COLUMN     "clarificationQuestion" TEXT;
