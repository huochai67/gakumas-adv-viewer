
#include "clhca.c"

int decode_hca_all(const unsigned char* data, unsigned int size, float* out_pcm, unsigned int max_samples, int* out_sr) {
    clHCA* hca = clHCA_new();
    if (!hca) return -100;
    int err = clHCA_DecodeHeader(hca, data, size);
    if (err < 0) { clHCA_delete(hca); return err; }
    clHCA_stInfo info;
    clHCA_getInfo(hca, &info);
    if (out_sr) *out_sr = (int)info.samplingRate;
    if (info.channelCount != 1) { clHCA_delete(hca); return -101; }

    float block_pcm[1024];
    unsigned char block_buf[8192];
    if (info.blockSize > sizeof(block_buf)) { clHCA_delete(hca); return -102; }

    unsigned int pos = info.headerSize;
    unsigned int total_written = 0;
    unsigned int raw_sample_idx = 0;
    unsigned int keep_start = info.encoderDelay;
    unsigned int keep_end = info.encoderDelay + info.sampleCount;

    for (unsigned int b = 0; b < info.blockCount; b++) {
        if (pos + info.blockSize > size) break;
        memcpy(block_buf, data + pos, info.blockSize);
        pos += info.blockSize;
        err = clHCA_DecodeBlock(hca, block_buf, info.blockSize);
        if (err < 0) { clHCA_delete(hca); return -200 + err; }
        clHCA_ReadSamples(hca, block_pcm);
        for (unsigned int s = 0; s < info.samplesPerBlock; s++) {
            if (raw_sample_idx >= keep_start && raw_sample_idx < keep_end) {
                if (total_written < max_samples) {
                    out_pcm[total_written++] = block_pcm[s];
                }
            }
            raw_sample_idx++;
        }
    }
    clHCA_delete(hca);
    return (int)total_written;
}
