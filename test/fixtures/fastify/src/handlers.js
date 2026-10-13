export async function listOrders() {
  return [];
}

export async function listItems(request) {
  return { order: request.params.orderId, items: [] };
}

export async function replaceOrder(request) {
  return request.body;
}
