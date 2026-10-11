import { Controller, Get, Put, Param } from '@nestjs/common';

@Controller({ path: 'orders', host: 'shop.example.com' })
export class OrdersController {
  @Get()
  list() {
    return [];
  }

  @Get(':orderId/items')
  items(@Param('orderId') orderId: string) {
    return { orderId, items: [] };
  }

  @Put(':orderId')
  replace(@Param('orderId') orderId: string) {
    return { orderId };
  }
}
