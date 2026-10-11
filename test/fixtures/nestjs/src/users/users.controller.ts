import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

// @Get('from-a-comment') must not count
@Controller('users')
export class UsersController {
  @Get()
  list() {
    return [];
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return { id };
  }

  @Post()
  create(@Body() body: unknown) {
    return body;
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    return { id, ...(body as object) };
  }

  /* @Delete('in-a-block-comment') must not count either */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return { id };
  }
}
