CREATE TABLE "name_servers" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "ipv4" TEXT,
    "ipv6" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "name_servers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "name_servers_hostname_key" ON "name_servers"("hostname");
CREATE INDEX "name_servers_active_sort_order_idx" ON "name_servers"("active", "sort_order");
