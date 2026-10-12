package com.example.shop;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

// a client of another service: the same annotations, and no route of this application
@FeignClient(name = "payments")
public interface PaymentClient {

    @GetMapping("/payments/{id}")
    Payment get(@PathVariable String id);
}
