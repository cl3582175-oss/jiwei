-- 向量索引（sqlite-vec）：512 维余弦距离；rowid 对应 chunks.rowid
-- 注意：vec0 的列定义不能使用反引号
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[512] distance_metric=cosine);
