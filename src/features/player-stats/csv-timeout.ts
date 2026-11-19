/** 结束页面等待；浏览器请求无法取消时，由调用方的批次守卫拒绝晚到结果。 */
export async function withCsvTimeout<T, R = never>(
  operation: Promise<T>,
  milliseconds: number,
  onTimeout: () => R,
): Promise<T | R> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<R>((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            resolve(onTimeout())
          } catch (error) {
            reject(error)
          }
        }, milliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
